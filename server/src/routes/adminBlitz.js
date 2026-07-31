const { createNotifications } = require('./notifications');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../db/supabase');
const adminAuth = require('../middleware/adminAuth');
const { scoreAndCompleteTournament } = require('../services/blitzScheduler');

const router = express.Router();

router.use(adminAuth);

// ─── TOURNAMENT CRUD ──────────────────────────────────────────────────────────

/**
 * GET /api/admin/blitz
 * List all tournaments
 */
router.get('/', async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let query = supabase
      .from('blitz_tournaments')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (status) query = query.eq('status', status);

    const { data, error, count } = await query;

    if (error) return res.status(500).json({ success: false, error: 'Failed to fetch tournaments' });

    return res.json({ success: true, data: { tournaments: data, total: count, page: Number(page), limit: Number(limit) } });
  } catch (err) {
    console.error('Admin get blitz error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch tournaments' });
  }
});

/**
 * POST /api/admin/blitz
 * Create a tournament with configurable payout distribution.
 *
 * Body: {
 *   title, description, entry_fee, question_count, time_limit_seconds,
 *   registration_start, tournament_start, tournament_end,
 *   max_participants           (default 20)
 *   min_participants           (default 1)
 *   per_question_time_seconds  (default 8)
 *   first_place_percent        (integer 1-100) — % of actual entry revenue → 1st place cash
 *   third_place_discount_percent (integer 1-99) — % off next entry for 3rd place ticket
 *   -- legacy fields still accepted for backward compat --
 *   cash_winner_count, payout_distribution, total_payout_percent,
 *   ticket_tier_percent, guaranteed_minimum, position_prizes
 * }
 *
 * When first_place_percent is set, the new fixed prize model is used at scoring:
 *   1st = cash (first_place_percent % of total_registered * entry_fee)
 *   2nd = free-entry ticket (always)
 *   3rd = discount ticket (third_place_discount_percent % off next entry)
 * When first_place_percent is null, legacy payout_distribution/position_prizes apply.
 */
router.post('/', async (req, res) => {
  try {
    const {
      title, description, entry_fee, question_count, time_limit_seconds,
      registration_start, tournament_start, tournament_end,
      max_participants = 20,
      min_participants = 1,
      per_question_time_seconds = 8,
      first_place_percent = null,
      third_place_discount_percent = null,
      // legacy fields
      cash_winner_count = 1,
      payout_distribution = [100],
      total_payout_percent = 80,
      ticket_tier_percent = 0,
      guaranteed_minimum = null,
      position_prizes = null,
    } = req.body;

    if (!title || entry_fee === undefined || !question_count || !time_limit_seconds ||
        !registration_start || !tournament_start || !tournament_end) {
      return res.status(400).json({
        success: false,
        error: 'title, entry_fee, question_count, time_limit_seconds, registration_start, tournament_start, tournament_end are required',
      });
    }

    // Validate new prize fields
    if (first_place_percent !== null) {
      const fpp = Number(first_place_percent);
      if (isNaN(fpp) || fpp < 1 || fpp > 100) {
        return res.status(400).json({ success: false, error: 'first_place_percent must be between 1 and 100' });
      }
    }
    if (third_place_discount_percent !== null) {
      const tdp = Number(third_place_discount_percent);
      if (isNaN(tdp) || tdp < 1 || tdp > 99) {
        return res.status(400).json({ success: false, error: 'third_place_discount_percent must be between 1 and 99' });
      }
    }

    // Validate per_question_time_seconds
    if (per_question_time_seconds !== null && (Number(per_question_time_seconds) < 3 || Number(per_question_time_seconds) > 120)) {
      return res.status(400).json({ success: false, error: 'per_question_time_seconds must be between 3 and 120 seconds' });
    }

    // Legacy payout field validation — only run when new prize model is NOT in use
    if (first_place_percent === null) {
      if (!Array.isArray(payout_distribution)) {
        return res.status(400).json({ success: false, error: 'payout_distribution must be an array' });
      }

      if (payout_distribution.length !== cash_winner_count) {
        return res.status(400).json({
          success: false,
          error: `payout_distribution length (${payout_distribution.length}) must match cash_winner_count (${cash_winner_count})`,
        });
      }

      const distributionSum = payout_distribution.reduce((a, b) => a + Number(b), 0);
      if (distributionSum !== 100) {
        return res.status(400).json({
          success: false,
          error: `payout_distribution values must sum to exactly 100 (current sum: ${distributionSum})`,
        });
      }

      if (total_payout_percent < 1 || total_payout_percent > 100) {
        return res.status(400).json({ success: false, error: 'total_payout_percent must be between 1 and 100' });
      }

      if (position_prizes !== null) {
        if (!Array.isArray(position_prizes)) {
          return res.status(400).json({ success: false, error: 'position_prizes must be an array' });
        }
        for (const p of position_prizes) {
          if (!p.position || !p.prize_type) {
            return res.status(400).json({ success: false, error: 'Each position_prizes entry must have position and prize_type' });
          }
          if (!['free_ticket', 'discount'].includes(p.prize_type)) {
            return res.status(400).json({ success: false, error: `Invalid prize_type "${p.prize_type}" — must be free_ticket or discount` });
          }
          if (p.prize_type === 'discount' && (p.discount_percent === undefined || p.discount_percent <= 0 || p.discount_percent >= 100)) {
            return res.status(400).json({ success: false, error: 'discount prize_type requires discount_percent between 1 and 99' });
          }
          if (p.position <= cash_winner_count) {
            return res.status(400).json({
              success: false,
              error: `position_prizes position ${p.position} overlaps with a cash winner rank (cash_winner_count is ${cash_winner_count})`,
            });
          }
        }
      }
    }

    // Collect warnings (non-blocking advisories returned alongside success)
    const warnings = [];

    if (total_payout_percent > 90) {
      warnings.push('total_payout_percent above 90% — platform keeps less than 10%');
    }

    if (Number(max_participants) >= 50) {
      warnings.push(
        `max_participants is set to ${max_participants}. At this scale all players may attempt simultaneously. ` +
        `Recommended maximum for current infrastructure: 50. ` +
        `Above 100 concurrent players, consider increasing your Supabase plan.`
      );
    }

    if (Number(max_participants) > 100) {
      warnings.push(
        `⚠️  CAUTION: max_participants ${max_participants} exceeds the safe limit for the current Supabase free/starter tier. ` +
        `You risk DB connection exhaustion under simultaneous load. ` +
        `Upgrade to Supabase Pro before publishing if you intend to run this.`
      );
    }

    const { data, error } = await supabase
      .from('blitz_tournaments')
      .insert({
        title,
        description: description || null,
        entry_fee: Number(entry_fee),
        question_count: Number(question_count),
        time_limit_seconds: Number(time_limit_seconds),
        per_question_time_seconds: per_question_time_seconds !== null ? Number(per_question_time_seconds) : null,
        registration_start: new Date(registration_start).toISOString(),
        tournament_start: new Date(tournament_start).toISOString(),
        tournament_end: new Date(tournament_end).toISOString(),
        max_participants: Number(max_participants),
        min_participants: Number(min_participants),
        cash_winner_count: Number(cash_winner_count),
        payout_distribution,
        total_payout_percent: Number(total_payout_percent),
        ticket_tier_percent: Number(ticket_tier_percent),
        guaranteed_minimum: guaranteed_minimum ? Number(guaranteed_minimum) : null,
        position_prizes: position_prizes || null,
        first_place_percent: first_place_percent !== null ? Number(first_place_percent) : null,
        third_place_discount_percent: third_place_discount_percent !== null ? Number(third_place_discount_percent) : null,
        status: 'draft',
        total_registered: 0,
        prize_pool: 0,
        created_by: req.admin?.id || null,
      })
      .select()
      .single();

    if (error) return res.status(500).json({ success: false, error: 'Failed to create tournament: ' + error.message });

    const response = { success: true, data: { tournament: data } };
    if (warnings.length > 0) response.warnings = warnings;

    return res.status(201).json(response);
  } catch (err) {
    console.error('Create blitz error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create tournament' });
  }
});

/**
 * GET /api/admin/blitz/:id
 * Single tournament detail — full config + current registered player count + all questions
 * 
 * Returns:
 * - tournament: all fields including entry_fee, question_count, max_players, prize_pool/payout_split,
 *   registration_deadline, title, status
 * - current_registered_count: real-time count from blitz_registrations table
 * - questions: all questions for this tournament
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: tournament, error: tErr } = await supabase
      .from('blitz_tournaments')
      .select('*')
      .eq('id', id)
      .single();

    if (tErr || !tournament) {
      return res.status(404).json({ success: false, error: 'Tournament not found' });
    }

    // Get real-time registered player count
    const { count: registeredCount, error: countErr } = await supabase
      .from('blitz_registrations')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', id);

    if (countErr) {
      console.error('Error fetching registration count:', countErr);
      return res.status(500).json({ success: false, error: 'Failed to fetch registration count' });
    }

    // Fetch all questions for this tournament
    const { data: questions } = await supabase
      .from('blitz_questions')
      .select('id, question, format, options, correct_answer, image_url, order_index, created_at')
      .eq('tournament_id', id)
      .order('order_index', { ascending: true });

    return res.json({
      success: true,
      data: {
        tournament: {
          id: tournament.id,
          title: tournament.title,
          description: tournament.description,
          status: tournament.status,
          entry_fee: tournament.entry_fee,
          question_count: tournament.question_count,
          time_limit_seconds: tournament.time_limit_seconds,
          per_question_time_seconds: tournament.per_question_time_seconds,
          registration_start: tournament.registration_start,
          tournament_start: tournament.tournament_start,
          tournament_end: tournament.tournament_end,
          max_participants: tournament.max_participants,
          min_participants: tournament.min_participants,
          total_registered: tournament.total_registered,
          prize_pool: tournament.prize_pool,
          first_place_percent: tournament.first_place_percent,
          third_place_discount_percent: tournament.third_place_discount_percent,
          cash_winner_count: tournament.cash_winner_count,
          payout_distribution: tournament.payout_distribution,
          total_payout_percent: tournament.total_payout_percent,
          ticket_tier_percent: tournament.ticket_tier_percent,
          guaranteed_minimum: tournament.guaranteed_minimum,
          position_prizes: tournament.position_prizes,
          created_by: tournament.created_by,
          created_at: tournament.created_at,
        },
        current_registered_count: registeredCount || 0,
        questions: questions || [],
      },
    });
  } catch (err) {
    console.error('Admin get blitz detail error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch tournament' });
  }
});

/**
 * PUT /api/admin/blitz/:id
 * Update tournament (only if draft)
 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Prevent changing these
    delete updates.id;
    delete updates.created_by;
    delete updates.created_at;
    delete updates.total_registered;
    delete updates.prize_pool;
    delete updates.status;

    const { data, error } = await supabase
      .from('blitz_tournaments')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error || !data) return res.status(404).json({ success: false, error: 'Tournament not found or update failed' });

    return res.json({ success: true, data: { tournament: data } });
  } catch (err) {
    console.error('Update blitz error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update tournament' });
  }
});

/**
 * PATCH /api/admin/blitz/:id
 * Edit tournament with strict lock rules.
 * 
 * Allowed fields: entry_fee, question_count, max_participants, registration_start
 * 
 * Lock rule:
 *   - If registered_count > 0: Reject entire request ("Cannot edit — N players already registered")
 *   - If registered_count === 0: Apply update normally
 *   - NEVER allow editing prize_pool or title, regardless of registration count
 * 
 * All edits are logged with audit trail.
 * Lock is all-or-nothing (no partial edits).
 */
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.admin?.id || null;

    // Fetch current tournament
    const { data: tournament, error: fetchErr } = await supabase
      .from('blitz_tournaments')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !tournament) {
      return res.status(404).json({ success: false, error: 'Tournament not found' });
    }

    // Get real registered player count from blitz_registrations
    const { count: registeredCount, error: countErr } = await supabase
      .from('blitz_registrations')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', id);

    if (countErr) {
      console.error('Error checking registration count:', countErr);
      return res.status(500).json({ success: false, error: 'Failed to check registration count' });
    }

    const realRegisteredCount = registeredCount || 0;

    // Check lock condition: if players registered, reject all updates
    if (realRegisteredCount > 0) {
      return res.status(409).json({
        success: false,
        error: `Cannot edit — ${realRegisteredCount} ${realRegisteredCount === 1 ? 'player has' : 'players have'} already registered`,
      });
    }

    // Extract allowed fields only (whitelist)
    const allowedFields = ['entry_fee', 'question_count', 'max_participants', 'registration_start'];
    const updates = {};
    let hasAllowedUpdates = false;

    for (const field of allowedFields) {
      if (field in req.body) {
        updates[field] = req.body[field];
        hasAllowedUpdates = true;
      }
    }

    // Explicitly reject prize_pool and title if user tries to update them
    if ('prize_pool' in req.body || 'title' in req.body) {
      return res.status(400).json({
        success: false,
        error: 'Cannot edit prize_pool or title through this endpoint. These fields are protected.',
      });
    }

    if (!hasAllowedUpdates) {
      return res.status(400).json({
        success: false,
        error: 'No allowed fields to update. Allowed fields: entry_fee, question_count, max_participants, registration_start',
      });
    }

    // Validate individual field constraints before applying
    if ('entry_fee' in updates && updates.entry_fee !== null) {
      const entryFee = Number(updates.entry_fee);
      if (isNaN(entryFee) || entryFee < 0) {
        return res.status(400).json({ success: false, error: 'entry_fee must be a non-negative number' });
      }
    }

    if ('question_count' in updates && updates.question_count !== null) {
      const qCount = Number(updates.question_count);
      if (isNaN(qCount) || qCount < 1 || qCount > 100) {
        return res.status(400).json({ success: false, error: 'question_count must be between 1 and 100' });
      }
    }

    if ('max_participants' in updates && updates.max_participants !== null) {
      const maxParts = Number(updates.max_participants);
      if (isNaN(maxParts) || maxParts < 1 || maxParts > 10000) {
        return res.status(400).json({ success: false, error: 'max_participants must be between 1 and 10000' });
      }
    }

    // Apply all updates at once (all-or-nothing)
    const { data: updatedTournament, error: updateErr } = await supabase
      .from('blitz_tournaments')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (updateErr || !updatedTournament) {
      console.error('Tournament update error:', updateErr);
      return res.status(500).json({ success: false, error: 'Failed to update tournament' });
    }

    // Log audit trail for each changed field
    const now = new Date().toISOString();
    const auditEntries = [];

    for (const field of allowedFields) {
      if (field in updates && tournament[field] !== updates[field]) {
        auditEntries.push({
          admin_id: adminId,
          action: 'blitz_tournament_edit',
          object_id: id,
          object_type: 'blitz_tournament',
          details: {
            field,
            old_value: tournament[field],
            new_value: updates[field],
            tournament_title: tournament.title,
            registered_count_at_edit: realRegisteredCount,
          },
          created_at: now,
        });
      }
    }

    if (auditEntries.length > 0) {
      const { error: auditErr } = await supabase
        .from('admin_audit_log')
        .insert(auditEntries);

      if (auditErr) {
        console.error('Audit log insertion error:', auditErr);
        // Still return success — audit failure should not block the update
      }
    }

    return res.json({
      success: true,
      data: {
        tournament: updatedTournament,
        audit: {
          changes_count: auditEntries.length,
          registered_players_at_edit: realRegisteredCount,
        },
      },
    });
  } catch (err) {
    console.error('Patch blitz error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update tournament' });
  }
});

// ─── QUESTION MANAGEMENT ──────────────────────────────────────────────────────

/**
 * Shared image upload handler — used by both:
 *   POST /api/admin/blitz/temp/questions/upload-image  (pre-creation, no tournament yet)
 *   POST /api/admin/blitz/:id/questions/upload-image   (existing tournament)
 *
 * Accepts multipart/form-data.
 * Field name: 'file' (frontend) OR 'image' (legacy) — both accepted.
 * Max size: 5 MB. Allowed types: jpeg, png, webp, gif.
 * Uploads to Supabase Storage bucket 'blitz-images'.
 * Returns: { success: true, data: { url, path } }
 */
async function handleBlitzImageUpload(req, res, contextId) {
  try {
    const chunks = [];
    let filename = `blitz-${contextId}-${Date.now()}`;
    let mimeType = 'image/jpeg';
    let fieldFound = false;

    await new Promise((resolve, reject) => {
      const busboy = require('busboy');
      const bb = busboy({
        headers: req.headers,
        limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
      });

      bb.on('file', (fieldname, file, info) => {
        // Accept 'file' (frontend default) or 'image' (legacy)
        if (fieldname !== 'file' && fieldname !== 'image') { file.resume(); return; }
        fieldFound = true;
        mimeType = info.mimeType || 'image/jpeg';

        const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
        filename = `blitz-${contextId}-${Date.now()}.${ext}`;

        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
        if (!allowedTypes.includes(mimeType)) {
          reject(new Error(`Unsupported image type: ${mimeType}. Use jpeg, png, webp, or gif.`));
          return;
        }

        file.on('data', (chunk) => chunks.push(chunk));
        file.on('end', resolve);
        file.on('error', reject);
        file.on('limit', () => reject(new Error('Image exceeds 5 MB limit')));
      });

      bb.on('error', reject);
      bb.on('finish', () => { if (!fieldFound) reject(new Error('No image field found in request (expected field name: file)')); });
      req.pipe(bb);
    });

    const buffer = Buffer.concat(chunks);

    const storagePath = `questions/${filename}`;
    const { error: uploadError } = await supabase.storage
      .from('blitz-images')
      .upload(storagePath, buffer, {
        contentType: mimeType,
        upsert: false,
      });

    if (uploadError) {
      console.error('[blitz upload] Storage error:', uploadError.message);
      return res.status(500).json({ success: false, error: 'Image upload failed: ' + uploadError.message });
    }

    const { data: urlData } = supabase.storage
      .from('blitz-images')
      .getPublicUrl(storagePath);

    return res.status(201).json({
      success: true,
      data: { url: urlData.publicUrl, path: storagePath },
    });
  } catch (err) {
    console.error('Upload blitz image error:', err);
    const statusCode = err.message?.includes('Unsupported') || err.message?.includes('5 MB') ? 400 : 500;
    return res.status(statusCode).json({ success: false, error: err.message || 'Image upload failed' });
  }
}

/**
 * POST /api/admin/blitz/temp/questions/upload-image
 * Temp upload for Blitz create flow — no tournament ID required.
 * MUST be registered before /:id/questions/upload-image so Express
 * does not try to match 'temp' as a tournament UUID.
 * Field name: file (or image). Returns { data: { url, path } }.
 */
router.post('/temp/questions/upload-image', async (req, res) => {
  return handleBlitzImageUpload(req, res, `temp-${Date.now()}`);
});

/**
 * POST /api/admin/blitz/:id/questions/upload-image
 * Upload an image for a blitz question to Supabase Storage.
 * MUST be registered BEFORE /:id/questions to avoid Express matching
 * "upload-image" as a question body on the generic POST /:id/questions route.
 * Content-Type: multipart/form-data
 * Field: file or image (file, max 5MB, jpeg/png/webp/gif)
 *
 * Returns: { url: "https://..." } — pass this as image_url when adding the question.
 */
router.post('/:id/questions/upload-image', async (req, res) => {
  const { id } = req.params;

  // Verify tournament exists (skip for 'temp' — handled by the route above)
  const { data: tournament } = await supabase
    .from('blitz_tournaments')
    .select('id')
    .eq('id', id)
    .single();

  if (!tournament) return res.status(404).json({ success: false, error: 'Tournament not found' });

  return handleBlitzImageUpload(req, res, id);
});

/**
 * POST /api/admin/blitz/:id/questions
 * Add a question to tournament.
 * Body: { question, format, options, correct_answer, order_index, image_url? }
 *
 * image_url: a Supabase Storage public URL (upload via POST /api/admin/blitz/:id/questions/upload-image first)
 */
router.post('/:id/questions', async (req, res) => {
  try {
    const { id } = req.params;
    const { question, format, options, correct_answer, order_index, image_url } = req.body;

    if (!question || !format || !correct_answer) {
      return res.status(400).json({ success: false, error: 'question, format, and correct_answer are required' });
    }

    if (!['multiple_choice', 'type_answer'].includes(format)) {
      return res.status(400).json({ success: false, error: 'format must be multiple_choice or type_answer' });
    }

    if (format === 'multiple_choice' && (!options || !Array.isArray(options) || options.length < 2)) {
      return res.status(400).json({ success: false, error: 'multiple_choice questions require at least 2 options' });
    }

    if (format === 'multiple_choice' && !options.includes(correct_answer)) {
      return res.status(400).json({ success: false, error: 'correct_answer must be one of the provided options' });
    }

    // Get current question count for auto order_index
    const { count } = await supabase
      .from('blitz_questions')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', id);

    const { data, error } = await supabase
      .from('blitz_questions')
      .insert({
        tournament_id: id,
        question,
        format,
        options: options || null,
        correct_answer,
        image_url: image_url || null,
        order_index: order_index ?? (count || 0) + 1,
      })
      .select()
      .single();

    if (error) return res.status(500).json({ success: false, error: 'Failed to add question: ' + error.message });

    return res.status(201).json({ success: true, data: { question: data } });
  } catch (err) {
    console.error('Add blitz question error:', err);
    return res.status(500).json({ success: false, error: 'Failed to add question' });
  }
});

/**
 * DELETE /api/admin/blitz/:id/questions/:qid
 * Remove a question from tournament
 */
router.delete('/:id/questions/:qid', async (req, res) => {
  try {
    const { id, qid } = req.params;

    const { error } = await supabase
      .from('blitz_questions')
      .delete()
      .eq('id', qid)
      .eq('tournament_id', id);

    if (error) return res.status(500).json({ success: false, error: 'Failed to remove question' });

    return res.json({ success: true, data: { message: 'Question removed' } });
  } catch (err) {
    console.error('Remove blitz question error:', err);
    return res.status(500).json({ success: false, error: 'Failed to remove question' });
  }
});

// ─── STATUS TRANSITIONS ───────────────────────────────────────────────────────

/**
 * POST /api/admin/blitz/:id/publish
 * draft → registration
 */
router.post('/:id/publish', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: tournament } = await supabase.from('blitz_tournaments').select('status, question_count').eq('id', id).single();
    if (!tournament) return res.status(404).json({ success: false, error: 'Tournament not found' });
    if (tournament.status !== 'draft') return res.status(400).json({ success: false, error: `Cannot publish: status is ${tournament.status}` });

    // Verify questions match question_count
    const { count } = await supabase.from('blitz_questions').select('id', { count: 'exact', head: true }).eq('tournament_id', id);
    if ((count || 0) < tournament.question_count) {
      return res.status(400).json({
        success: false,
        error: `Tournament needs ${tournament.question_count} questions but only has ${count || 0}`,
      });
    }

    const { data } = await supabase.from('blitz_tournaments').update({ status: 'registration' }).eq('id', id).select().single();

    // Notify all players about new tournament
    const { data: allPlayers } = await supabase.from('players').select('id');
    if (allPlayers && allPlayers.length > 0) {
      await createNotifications(allPlayers.map((p) => ({
        player_id: p.id,
        type: 'new_event',
        title: 'New Blitz Tournament! ⚡',
        message: `${data.title} — Register now`,
      })));
    }

    return res.json({ success: true, data: { tournament: data } });
  } catch (err) {
    console.error('Publish blitz error:', err);
    return res.status(500).json({ success: false, error: 'Failed to publish tournament' });
  }
});

/**
 * POST /api/admin/blitz/:id/activate
 * registration → active
 */
router.post('/:id/activate', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: tournament } = await supabase.from('blitz_tournaments').select('status').eq('id', id).single();
    if (!tournament) return res.status(404).json({ success: false, error: 'Tournament not found' });
    if (tournament.status !== 'registration') return res.status(400).json({ success: false, error: `Cannot activate: status is ${tournament.status}` });

    const { data } = await supabase.from('blitz_tournaments').update({ status: 'active' }).eq('id', id).select().single();
    return res.json({ success: true, data: { tournament: data } });
  } catch (err) {
    console.error('Activate blitz error:', err);
    return res.status(500).json({ success: false, error: 'Failed to activate tournament' });
  }
});

/**
 * POST /api/admin/blitz/:id/score
 *
 * Rank by score DESC, then total_time_ms ASC.
 *
 * Prize distribution:
 *  - Cash prizes  → top cash_winner_count players, split per payout_distribution
 *  - position_prizes (if set) → explicit per-position non-cash awards:
 *      { position: 2, prize_type: "free_ticket" }
 *      { position: 3, prize_type: "discount", discount_percent: 50 }
 *  - ticket_tier_percent fallback → if position_prizes is null, award free
/**
 * POST /api/admin/blitz/:id/score
 * Manual admin override — calls the same shared scoring logic used by the scheduler.
 * Idempotent: already-awarded prizes are skipped, so re-running is safe.
 */
router.post('/:id/score', async (req, res) => {
  try {
    const { id } = req.params;

    // Verify tournament exists and is scoreable before delegating
    const { data: tournament } = await supabase
      .from('blitz_tournaments')
      .select('id, status')
      .eq('id', id)
      .single();

    if (!tournament) return res.status(404).json({ success: false, error: 'Tournament not found' });
    if (!['active', 'scoring'].includes(tournament.status)) {
      return res.status(400).json({ success: false, error: `Cannot score: status is ${tournament.status}` });
    }

    const summary = await scoreAndCompleteTournament(id, 'admin');
    return res.json({ success: true, data: summary });
  } catch (err) {
    console.error('Score blitz error:', err);
    return res.status(500).json({ success: false, error: 'Failed to score tournament' });
  }
});

// ─── ADMIN VIEWS ──────────────────────────────────────────────────────────────

/**
 * GET /api/admin/blitz/:id/leaderboard
 * Full ranked leaderboard
 */
router.get('/:id/leaderboard', async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 50 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const { data: attempts, count } = await supabase
      .from('blitz_attempts')
      .select('player_id, score, total_time_ms, completed_at, players(id, phone, name)', { count: 'exact' })
      .eq('tournament_id', id)
      .eq('status', 'completed')
      .order('score', { ascending: false })
      .order('total_time_ms', { ascending: true })
      .range(offset, offset + Number(limit) - 1);

    const leaderboard = (attempts || []).map((a, i) => ({
      position: offset + i + 1,
      player_id: a.player_id,
      name: a.players?.name || null,
      phone: a.players?.phone || null,
      score: a.score,
      total_time_ms: a.total_time_ms,
      completed_at: a.completed_at,
    }));

    return res.json({ success: true, data: { leaderboard, total: count, page: Number(page), limit: Number(limit) } });
  } catch (err) {
    console.error('Admin blitz leaderboard error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch leaderboard' });
  }
});

/**
 * GET /api/admin/blitz/:id/results
 *
 * Full post-tournament review for admin. Only available when status = 'completed'.
 *
 * Returns:
 *  - tournament config (prize model, entry_fee, first_place_percent, third_place_discount_percent)
 *  - Every registered player with:
 *      rank, score, total_time_ms, submitted (bool), registered_at, entry_fee_paid
 *  - Real prize outcome per player (from blitz_prizes + blitz_tickets)
 *  - Revenue audit: total collected, total cash paid out, math check
 *  - Scoring event: when it ran, triggered_by (scheduler vs admin)
 *
 * Real table/column references:
 *  blitz_registrations: tournament_id, player_id, entry_fee_paid, registered_at, ticket
 *  blitz_attempts: tournament_id, player_id, score, total_time_ms, completed_at, status
 *  blitz_prizes: tournament_id, player_id, position, prize_type, amount, ticket_code, distributed_at
 *  blitz_tickets: ticket_code, status, discount_percent, used_on_tournament_id, awarded_at
 *  admin_audit_log: entity_id, action='blitz_scored', resolution (triggered_by), created_at
 *  transactions: player_id, type='blitz_entry', amount (negative = entry fee paid)
 */
router.get('/:id/results', async (req, res) => {
  try {
    const { id } = req.params;

    // ── 1. Fetch tournament ───────────────────────────────────────────────
    const { data: tournament, error: tErr } = await supabase
      .from('blitz_tournaments')
      .select('id, title, status, entry_fee, max_participants, total_registered, prize_pool, first_place_percent, third_place_discount_percent, total_payout_percent, payout_distribution, cash_winner_count, position_prizes, registration_start, tournament_start, tournament_end')
      .eq('id', id)
      .single();

    if (tErr || !tournament) return res.status(404).json({ success: false, error: 'Tournament not found' });
    if (tournament.status !== 'completed') {
      return res.status(400).json({ success: false, error: `Results only available for completed tournaments (current status: ${tournament.status})` });
    }

    // ── 2. All registrations (everyone who paid to enter) ─────────────────
    // blitz_registrations.entry_fee_paid is the actual amount each player paid (0 for free-ticket entries)
    const { data: registrations } = await supabase
      .from('blitz_registrations')
      .select('player_id, entry_fee_paid, registered_at, ticket, players(id, phone, name)')
      .eq('tournament_id', id)
      .order('registered_at', { ascending: true });

    // ── 3. All attempts (submitted scores) ────────────────────────────────
    // blitz_attempts.status: 'completed' = submitted, 'in_progress' = started but not submitted
    const { data: attempts } = await supabase
      .from('blitz_attempts')
      .select('player_id, score, total_time_ms, completed_at, status')
      .eq('tournament_id', id);

    // Build a fast lookup map: player_id → attempt
    const attemptByPlayer = {};
    for (const a of attempts || []) {
      attemptByPlayer[a.player_id] = a;
    }

    // ── 4. Ranked ordering (score desc, time asc) for position assignment ─
    const completedAttempts = (attempts || [])
      .filter(a => a.status === 'completed')
      .sort((a, b) => b.score - a.score || a.total_time_ms - b.total_time_ms);

    const rankByPlayer = {};
    completedAttempts.forEach((a, i) => { rankByPlayer[a.player_id] = i + 1; });

    // ── 5. All prizes issued for this tournament ──────────────────────────
    // blitz_prizes: position, prize_type ('cash'|'free_ticket'|'discount'), amount, ticket_code, distributed_at
    const { data: prizes } = await supabase
      .from('blitz_prizes')
      .select('player_id, position, prize_type, amount, ticket_code, distributed_at')
      .eq('tournament_id', id);

    // Build lookup: player_id → prize row
    const prizeByPlayer = {};
    for (const p of prizes || []) {
      prizeByPlayer[p.player_id] = p;
    }

    // ── 6. Ticket redemption status for any ticket prizes ─────────────────
    // blitz_tickets: ticket_code (unique), status ('unused'|'used'|'expired'), used_on_tournament_id
    const ticketCodes = (prizes || [])
      .filter(p => p.ticket_code)
      .map(p => p.ticket_code);

    let ticketStatusByCode = {};
    if (ticketCodes.length > 0) {
      const { data: tickets } = await supabase
        .from('blitz_tickets')
        .select('ticket_code, status, discount_percent, used_on_tournament_id, awarded_at')
        .in('ticket_code', ticketCodes);

      for (const t of tickets || []) {
        ticketStatusByCode[t.ticket_code] = t;
      }
    }

    // ── 7. Scoring audit event ────────────────────────────────────────────
    // admin_audit_log: action='blitz_scored', entity_id=tournament_id, resolution=triggered_by
    const { data: auditRows } = await supabase
      .from('admin_audit_log')
      .select('resolution, notes, created_at, payload')
      .eq('action', 'blitz_scored')
      .eq('entity_id', id)
      .order('created_at', { ascending: false })
      .limit(1);

    const scoringEvent = auditRows && auditRows.length > 0 ? {
      scored_at: auditRows[0].created_at,
      triggered_by: auditRows[0].resolution, // 'scheduler' | 'admin' | 'player_request'
      notes: auditRows[0].notes,
    } : {
      // Fallback: derive from distributed_at on the earliest prize
      scored_at: prizes && prizes.length > 0
        ? prizes.reduce((earliest, p) => p.distributed_at < earliest ? p.distributed_at : earliest, prizes[0].distributed_at)
        : null,
      triggered_by: 'unknown — scored before audit logging was added',
      notes: null,
    };

    // ── 8. Build per-player result rows ───────────────────────────────────
    const playerResults = (registrations || []).map(reg => {
      const attempt = attemptByPlayer[reg.player_id] || null;
      const prize = prizeByPlayer[reg.player_id] || null;
      const rank = rankByPlayer[reg.player_id] || null;

      let prizeDetail = null;
      if (prize) {
        prizeDetail = {
          position: prize.position,
          prize_type: prize.prize_type, // 'cash' | 'free_ticket' | 'discount'
          amount_credited: prize.amount, // 0 for non-cash
          ticket_code: prize.ticket_code || null,
          distributed_at: prize.distributed_at,
          ticket_status: prize.ticket_code && ticketStatusByCode[prize.ticket_code]
            ? {
                // Compute live: if stored status is 'used' keep it; otherwise check expires_at
                status: ticketStatusByCode[prize.ticket_code].status === 'used'
                  ? 'used'
                  : new Date(ticketStatusByCode[prize.ticket_code].expires_at) < new Date()
                  ? 'expired'
                  : 'unused',
                discount_percent: ticketStatusByCode[prize.ticket_code].discount_percent,
                used_on_tournament_id: ticketStatusByCode[prize.ticket_code].used_on_tournament_id,
                awarded_at: ticketStatusByCode[prize.ticket_code].awarded_at,
                expires_at: ticketStatusByCode[prize.ticket_code].expires_at,
              }
            : null,
        };
      }

      return {
        player_id: reg.player_id,
        name: reg.players?.name || null,
        phone: reg.players?.phone || null,
        registered_at: reg.registered_at,
        entry_fee_paid: reg.entry_fee_paid,         // 0 if free-ticket entry
        used_ticket_code: reg.ticket || null,        // blitz_registrations.ticket
        submitted: attempt ? attempt.status === 'completed' : false,
        score: attempt ? attempt.score : null,
        total_time_ms: attempt ? attempt.total_time_ms : null,
        completed_at: attempt ? attempt.completed_at : null,
        rank,
        prize: prizeDetail,
      };
    });

    // Sort: ranked submitters first (by rank), then non-submitters
    playerResults.sort((a, b) => {
      if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
      if (a.rank !== null) return -1;
      if (b.rank !== null) return 1;
      return 0;
    });

    // ── 9. Revenue audit ──────────────────────────────────────────────────
    const totalRevenueClaimed = tournament.total_registered * Number(tournament.entry_fee);
    const totalRevenueActual = (registrations || []).reduce((sum, r) => sum + Number(r.entry_fee_paid || 0), 0);
    const totalCashPaid = (prizes || [])
      .filter(p => p.prize_type === 'cash')
      .reduce((sum, p) => sum + Number(p.amount || 0), 0);

    // Expected 1st place cash (new prize model)
    let expectedCashPrize = null;
    let mathCheck = null;
    if (tournament.first_place_percent != null) {
      expectedCashPrize = Math.round(totalRevenueActual * Number(tournament.first_place_percent) / 100);
      const platformKept = totalRevenueActual - totalCashPaid;
      mathCheck = {
        formula: `revenue(${tournament.total_registered} × ₦${tournament.entry_fee}) − 1st place cash(${tournament.first_place_percent}% of ₦${totalRevenueActual} = ₦${expectedCashPrize}) − platform = ₦${platformKept}`,
        expected: expectedCashPrize,
        actual_credited: totalCashPaid,
        match: expectedCashPrize === totalCashPaid,
      };
    } else {
      // Legacy model: cash pool = totalRevenue × total_payout_percent
      const legacyCashPool = Math.floor(totalRevenueClaimed * (Number(tournament.total_payout_percent || 80) / 100));
      mathCheck = {
        formula: `floor(${totalRevenueClaimed} × ${tournament.total_payout_percent || 80}% / 100)`,
        expected_pool: legacyCashPool,
        actual_credited: totalCashPaid,
        note: 'Legacy model — pool is split across multiple winners per payout_distribution',
      };
    }

    const revenueAudit = {
      entry_fee: Number(tournament.entry_fee),
      total_registered: tournament.total_registered,
      total_revenue_claimed: totalRevenueClaimed,         // entry_fee × total_registered (what the DB says)
      total_revenue_actual: totalRevenueActual,           // sum of entry_fee_paid from blitz_registrations
      discrepancy: totalRevenueClaimed - totalRevenueActual, // > 0 if some players used free/discount tickets
      total_cash_paid_out: totalCashPaid,
      platform_kept: totalRevenueActual - totalCashPaid,
      math_check: mathCheck,
    };

    return res.json({
      success: true,
      data: {
        tournament: {
          id: tournament.id,
          title: tournament.title,
          status: tournament.status,
          prize_model: tournament.first_place_percent != null ? 'fixed' : 'legacy',
          first_place_percent: tournament.first_place_percent,
          third_place_discount_percent: tournament.third_place_discount_percent,
          entry_fee: tournament.entry_fee,
          max_participants: tournament.max_participants,
          tournament_start: tournament.tournament_start,
          tournament_end: tournament.tournament_end,
        },
        scoring_event: scoringEvent,
        revenue_audit: revenueAudit,
        player_results: playerResults,
        totals: {
          registered: (registrations || []).length,
          submitted: completedAttempts.length,
          did_not_submit: (registrations || []).length - completedAttempts.length,
          prizes_issued: (prizes || []).length,
        },
      },
    });
  } catch (err) {
    console.error('Admin blitz results error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch results' });
  }
});

module.exports = router;
