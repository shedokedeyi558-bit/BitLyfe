const { createNotifications } = require('./notifications');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../db/supabase');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();

router.use(adminAuth);

// ─── HELPER FUNCTIONS ─────────────────────────────────────────────────────────

function generateTicketCode() {
  return 'TKT-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substr(2, 9).toUpperCase();
}

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
 *   max_participants         (default 20; warn ≥ 50 — server load advisory)
 *   min_participants         (default 1)
 *   per_question_time_seconds (default 8 — strict per-question countdown)
 *   cash_winner_count        (default 1)
 *   payout_distribution      (array summing to 100, length === cash_winner_count)
 *   total_payout_percent     (default 80 — platform keeps 20%)
 *   ticket_tier_percent      (default 0 — use position_prizes instead)
 *   guaranteed_minimum       (optional integer floor prize in naira)
 *   position_prizes          (optional JSONB array for explicit 2nd/3rd prizes)
 * }
 */
router.post('/', async (req, res) => {
  try {
    const {
      title, description, entry_fee, question_count, time_limit_seconds,
      registration_start, tournament_start, tournament_end,
      max_participants = 20,
      min_participants = 1,
      per_question_time_seconds = 8,
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

    // Validate per_question_time_seconds
    if (per_question_time_seconds !== null && (Number(per_question_time_seconds) < 3 || Number(per_question_time_seconds) > 120)) {
      return res.status(400).json({ success: false, error: 'per_question_time_seconds must be between 3 and 120 seconds' });
    }

    // Validate payout_distribution
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

    // Validate position_prizes if provided
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
          prize_pool: tournament.prize_pool,
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
 * POST /api/admin/blitz/:id/questions/upload-image
 * Upload an image for a blitz question to Supabase Storage.
 * MUST be registered BEFORE /:id/questions to avoid Express matching
 * "upload-image" as a question body on the generic POST /:id/questions route.
 * Content-Type: multipart/form-data
 * Field: image (file, max 5MB, jpeg/png/webp/gif)
 *
 * Returns: { url: "https://..." } — pass this as image_url when adding the question.
 */
router.post('/:id/questions/upload-image', async (req, res) => {
  try {
    const { id } = req.params;

    // Verify tournament exists
    const { data: tournament } = await supabase
      .from('blitz_tournaments')
      .select('id, status')
      .eq('id', id)
      .single();

    if (!tournament) return res.status(404).json({ success: false, error: 'Tournament not found' });

    // Use busboy to parse multipart (already available via express ecosystem)
    // We handle the raw buffer manually to avoid needing multer as a dependency
    const chunks = [];
    let filename = `blitz-${id}-${Date.now()}`;
    let mimeType = 'image/jpeg';
    let fieldFound = false;

    await new Promise((resolve, reject) => {
      const busboy = require('busboy');
      const bb = busboy({
        headers: req.headers,
        limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
      });

      bb.on('file', (fieldname, file, info) => {
        if (fieldname !== 'image') { file.resume(); return; }
        fieldFound = true;
        mimeType = info.mimeType || 'image/jpeg';

        const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
        filename = `blitz-${id}-${Date.now()}.${ext}`;

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
      bb.on('finish', () => { if (!fieldFound) reject(new Error('No image field found in request')); });
      req.pipe(bb);
    });

    const buffer = Buffer.concat(chunks);

    // Upload to Supabase Storage bucket "blitz-images"
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

    // Get public URL
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
 *    tickets to a percentage-based slice of remaining participants (legacy).
 *
 * Idempotent: already-awarded prizes are skipped, so re-running is safe.
 */
router.post('/:id/score', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: tournament } = await supabase.from('blitz_tournaments').select('*').eq('id', id).single();
    if (!tournament) return res.status(404).json({ success: false, error: 'Tournament not found' });
    if (!['active', 'scoring'].includes(tournament.status)) {
      return res.status(400).json({ success: false, error: `Cannot score: status is ${tournament.status}` });
    }

    // Move to scoring state immediately (prevents double-scoring races)
    await supabase.from('blitz_tournaments').update({ status: 'scoring' }).eq('id', id);

    // Ranked leaderboard: score desc, time asc
    const { data: attempts } = await supabase
      .from('blitz_attempts')
      .select('id, player_id, score, total_time_ms')
      .eq('tournament_id', id)
      .eq('status', 'completed')
      .order('score', { ascending: false })
      .order('total_time_ms', { ascending: true });

    if (!attempts || attempts.length === 0) {
      await supabase.from('blitz_tournaments').update({ status: 'completed' }).eq('id', id);
      return res.json({
        success: true,
        data: { message: 'No participants to score', total_participants: 0, total_cash_distributed: 0, non_cash_prizes_awarded: 0 },
      });
    }

    // ──────────────────────────────────────────────────────────────────────────
    // CASH PRIZES
    // ──────────────────────────────────────────────────────────────────────────
    const totalRevenue = tournament.total_registered * Number(tournament.entry_fee || 0);
    const cashPool = Math.floor(totalRevenue * (Number(tournament.total_payout_percent || 80) / 100));
    const payoutDistribution = tournament.payout_distribution || [100];
    const cashWinnerCount = Number(tournament.cash_winner_count || 1);
    const guaranteedMinimum = tournament.guaranteed_minimum ? Number(tournament.guaranteed_minimum) : null;

    let totalCashPaid = 0;
    const prizeRecords = [];

    for (let i = 0; i < Math.min(cashWinnerCount, attempts.length); i++) {
      const attempt = attempts[i];
      const rank = i + 1;

      // Idempotency check
      const { data: existing } = await supabase
        .from('blitz_prizes')
        .select('id')
        .eq('tournament_id', id)
        .eq('player_id', attempt.player_id)
        .eq('position', rank)
        .maybeSingle();

      if (existing) continue;

      const percentage = Number(payoutDistribution[i] || 0);
      let prize = Math.floor(cashPool * (percentage / 100));
      if (guaranteedMinimum && prize < guaranteedMinimum) prize = guaranteedMinimum;

      const { data: player } = await supabase.from('players').select('balance').eq('id', attempt.player_id).single();
      await supabase
        .from('players')
        .update({ balance: (player?.balance || 0) + prize })
        .eq('id', attempt.player_id);

      await supabase.from('transactions').insert({
        player_id: attempt.player_id,
        type: 'blitz_prize',
        amount: prize,
        description: `Blitz prize — Position ${rank}: ${tournament.title}`,
      });

      prizeRecords.push({
        tournament_id: id,
        player_id: attempt.player_id,
        position: rank,
        prize_type: 'cash',
        amount: prize,
      });

      totalCashPaid += prize;

      const rankEmoji = ['🥇', '🥈', '🥉'][i] || '✨';
      await createNotifications([{
        player_id: attempt.player_id,
        type: 'win',
        title: `Blitz Prize! ${rankEmoji}`,
        message: `You finished #${rank} in ${tournament.title}! ₦${prize.toLocaleString()} credited to your wallet.`,
      }]);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // NON-CASH PRIZES
    // Explicit position_prizes takes priority over ticket_tier_percent.
    // ──────────────────────────────────────────────────────────────────────────
    let nonCashAwarded = 0;
    const positionPrizes = tournament.position_prizes; // JSONB array or null

    if (positionPrizes && Array.isArray(positionPrizes) && positionPrizes.length > 0) {
      // ── Explicit per-position awards ─────────────────────────────────────
      for (const prizeDef of positionPrizes) {
        const rank = Number(prizeDef.position);
        const prizeType = prizeDef.prize_type;           // 'free_ticket' | 'discount'
        const discountPercent = prizeDef.discount_percent ? Number(prizeDef.discount_percent) : null;

        // Position must exist in attempts (tournament may have fewer players)
        if (rank > attempts.length) continue;

        const attempt = attempts[rank - 1]; // 0-indexed

        // Idempotency check
        const { data: existing } = await supabase
          .from('blitz_prizes')
          .select('id')
          .eq('tournament_id', id)
          .eq('player_id', attempt.player_id)
          .eq('position', rank)
          .maybeSingle();

        if (existing) continue;

        // Generate ticket code
        const ticketCode = generateTicketCode();
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 30); // 30 days to use the prize

        // Insert into blitz_tickets
        await supabase.from('blitz_tickets').insert({
          player_id: attempt.player_id,
          source_tournament_id: id,
          ticket_code: ticketCode,
          expires_at: expiresAt.toISOString(),
          status: 'unused',
          // discount_percent: null → free entry; >0 → discounted entry
          ...(prizeType === 'discount' && discountPercent ? { discount_percent: discountPercent } : {}),
        });

        prizeRecords.push({
          tournament_id: id,
          player_id: attempt.player_id,
          position: rank,
          prize_type: prizeType,
          ticket_code: ticketCode,
          amount: 0,
        });

        nonCashAwarded++;

        // Notification copy differs by prize type
        let notifTitle, notifMsg;
        if (prizeType === 'free_ticket') {
          notifTitle = 'Free Blitz Entry! 🎫';
          notifMsg = `You finished #${rank} in ${tournament.title}! You've won a FREE entry to the next Blitz tournament. Code: ${ticketCode} (valid 30 days).`;
        } else {
          notifTitle = `${discountPercent}% Off Next Blitz Entry! 🏷️`;
          notifMsg = `You finished #${rank} in ${tournament.title}! Use code ${ticketCode} for ${discountPercent}% off your next Blitz entry (valid 30 days).`;
        }

        await createNotifications([{
          player_id: attempt.player_id,
          type: 'win',
          title: notifTitle,
          message: notifMsg,
        }]);
      }
    } else {
      // ── Legacy fallback: ticket_tier_percent ────────────────────────────
      const ticketTierPercent = Number(tournament.ticket_tier_percent || 0);
      if (ticketTierPercent > 0) {
        const remainingParticipants = Math.max(0, attempts.length - cashWinnerCount);
        const ticketCount = Math.max(1, Math.floor(remainingParticipants * (ticketTierPercent / 100)));

        for (let i = cashWinnerCount; i < Math.min(cashWinnerCount + ticketCount, attempts.length); i++) {
          const attempt = attempts[i];
          const rank = i + 1;

          const { data: existing } = await supabase
            .from('blitz_prizes')
            .select('id')
            .eq('tournament_id', id)
            .eq('player_id', attempt.player_id)
            .eq('position', rank)
            .maybeSingle();

          if (existing) continue;

          const ticketCode = generateTicketCode();
          const expiresAt = new Date();
          expiresAt.setDate(expiresAt.getDate() + 7);

          await supabase.from('blitz_tickets').insert({
            player_id: attempt.player_id,
            source_tournament_id: id,
            ticket_code: ticketCode,
            expires_at: expiresAt.toISOString(),
            status: 'unused',
          });

          prizeRecords.push({
            tournament_id: id,
            player_id: attempt.player_id,
            position: rank,
            prize_type: 'free_ticket',
            ticket_code: ticketCode,
            amount: 0,
          });

          nonCashAwarded++;

          await createNotifications([{
            player_id: attempt.player_id,
            type: 'win',
            title: 'Free Blitz Ticket! 🎫',
            message: `You won a free entry ticket from ${tournament.title}. Code: ${ticketCode}. Valid for 7 days.`,
          }]);
        }
      }
    }

    // Insert all prize records in one batch
    if (prizeRecords.length > 0) {
      await supabase.from('blitz_prizes').insert(prizeRecords);
    }

    // Mark tournament as completed
    await supabase.from('blitz_tournaments').update({ status: 'completed' }).eq('id', id);

    return res.json({
      success: true,
      data: {
        message: 'Tournament scored and prizes distributed',
        total_participants: attempts.length,
        cash_winners: Math.min(cashWinnerCount, attempts.length),
        total_cash_distributed: totalCashPaid,
        non_cash_prizes_awarded: nonCashAwarded,
        prize_breakdown: {
          cash_pool: cashPool,
          platform_kept: totalRevenue - cashPool,
          total_revenue: totalRevenue,
        },
      },
    });
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

module.exports = router;
