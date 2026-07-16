const express = require('express');
const supabase = require('../db/supabase');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();

// Apply admin auth to all routes in this file
router.use(adminAuth);

// ─── PACK ROUTES (must come before /:id routes) ───────────────────────────────

/**
 * GET /api/admin/pills/packs
 * List all packs with their pills (admin view — includes all fields)
 */
router.get('/packs', async (req, res) => {
  try {
    const { data: packs, error: packsErr } = await supabase
      .from('pill_packs')
      .select('*')
      .order('created_at', { ascending: false });

    if (packsErr) return res.status(500).json({ success: false, error: 'Failed to fetch packs' });

    const packIds = (packs || []).map((p) => p.id);
    let pills = [];

    if (packIds.length > 0) {
      const { data: pillData } = await supabase
        .from('pills')
        .select('id, pack_id, question, category, entry_fee, prize, format, color, timer_seconds, status, correct_answer, options')
        .in('pack_id', packIds)
        .is('deleted_at', null)        // exclude soft-deleted from admin pack view
        .order('created_at', { ascending: true });

      pills = pillData || [];
    }

    const pillsByPack = {};
    for (const pill of pills) {
      if (!pillsByPack[pill.pack_id]) pillsByPack[pill.pack_id] = [];
      pillsByPack[pill.pack_id].push(pill);
    }

    const result = (packs || []).map((pack) => {
      const packPills = pillsByPack[pack.id] || [];
      const isSpecial = pack.pack_type === 'special' || pack.is_vip;
      const availableCount = packPills.filter((p) => p.status === 'available').length;

      // ── Entropy / bank-size ratio (Specials only) ────────────────────────
      // Helps admin know when the question bank is too thin to prevent
      // meaningful overlap between different players' attempts.
      // Recommendation: bank >= 3× question_count (e.g. 30 for a 10-question exam).
      let bankRatio = null;
      let lowEntropyWarning = null;
      let recommendedBankSize = null;

      if (isSpecial && pack.question_count) {
        const qc = pack.question_count;
        bankRatio = availableCount > 0 ? parseFloat((availableCount / qc).toFixed(2)) : 0;
        recommendedBankSize = qc * 3;
        if (availableCount < qc * 3) {
          lowEntropyWarning = availableCount < qc
            ? `Bank (${availableCount}) is below question_count (${qc}) — pack cannot start.`
            : `Bank (${availableCount}) is less than 3× question_count (${qc}). Recommend at least ${recommendedBankSize} questions to minimize overlap between attempts.`;
        }
      }

      return {
        ...pack,
        pills: packPills,
        available_count: availableCount,
        played_count: packPills.filter((p) => p.status === 'played').length,
        expired_count: packPills.filter((p) => p.status === 'expired').length,
        // ── Entropy fields ─────────────────────────────────────────────────
        bank_ratio: bankRatio,
        low_entropy_warning: lowEntropyWarning,
        recommended_bank_size: recommendedBankSize,
        // ── Quiz expiry fields ─────────────────────────────────────────────
        // quiz_expires_at: admin-set expiry for this Pills/Specials pack.
        // Independent of entry_window_end (Time Machine only).
        quiz_expires_at: pack.quiz_expires_at || null,
        // quiz_expired: true once the expiry time has passed.
        // Admin panel should show the pack as "Ended" when this is true.
        quiz_expired: pack.quiz_expires_at ? new Date(pack.quiz_expires_at) < new Date() : false,
      };
    });

    return res.json({ success: true, data: { packs: result } });
  } catch (err) {
    console.error('Admin get packs error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch packs' });
  }
});

/**
 * POST /api/admin/pills/packs
 * Create a new pill pack
 * Body: { name, category, status?, entry_fee?, prize?, quiz_expires_at? }
 * entry_fee and prize are pack-level — all pills in this pack share these values.
 *
 * quiz_expires_at: optional ISO timestamp (or duration expressed as hours, e.g.
 *   pass "24h" to get now + 24 hours, or a full ISO string for a specific time).
 *   Once this time passes, no new player entries are accepted server-side.
 *   Independent of entry_window_end — do NOT confuse the two.
 */
router.post('/packs', async (req, res) => {
  try {
    const {
      name, category, status, entry_fee, prize, is_vip,
      pack_type, question_count, total_time_seconds, required_correct, entry_window_end,
      quiz_expires_at,
    } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }

    // Resolve effective pack type — is_vip=true is treated as 'special' for new packs
    const effectiveType = pack_type || (is_vip ? 'special' : 'standard');
    const isSpecial = effectiveType === 'special';

    // Special pack validation
    if (isSpecial) {
      if (!question_count || question_count < 5 || question_count > 20) {
        return res.status(400).json({
          success: false,
          error: 'Special packs require question_count between 5 and 20',
        });
      }
      if (!total_time_seconds || total_time_seconds < 60) {
        return res.status(400).json({
          success: false,
          error: 'Special packs require total_time_seconds (minimum 60)',
        });
      }
      if (!required_correct || required_correct < 1 || required_correct > question_count) {
        return res.status(400).json({
          success: false,
          error: `required_correct must be between 1 and question_count (${question_count})`,
        });
      }
    }

    const { data, error } = await supabase
      .from('pill_packs')
      .insert({
        name,
        category: category || 'General',
        status: status || 'draft',
        entry_fee: entry_fee !== undefined ? Number(entry_fee) : null,
        prize: prize !== undefined ? Number(prize) : null,
        is_vip: is_vip === true || is_vip === 'true',
        pack_type: effectiveType,
        question_count: isSpecial ? Number(question_count) : null,
        total_time_seconds: isSpecial ? Number(total_time_seconds) : null,
        required_correct: isSpecial ? Number(required_correct) : null,
        entry_window_end: isSpecial && entry_window_end ? new Date(entry_window_end).toISOString() : null,
        // quiz_expires_at: Pills/Specials-only expiry — independent of entry_window_end
        quiz_expires_at: quiz_expires_at ? new Date(quiz_expires_at).toISOString() : null,
      })
      .select()
      .single();

    if (error) return res.status(500).json({ success: false, error: 'Failed to create pack' });

    return res.status(201).json({ success: true, data: { pack: { ...data, pills: [] } } });
  } catch (err) {
    console.error('Create pack error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create pack' });
  }
});

/**
 * PUT /api/admin/pills/packs/:packId/feature
 * Set or unset featured status. Body: { featured: boolean }
 * Setting featured: true on one pack unsets is_featured on every other standard pack.
 * Only allowed on standard packs — not Specials.
 */
router.put('/packs/:packId/feature', async (req, res) => {
  try {
    const { packId } = req.params;
    const { featured } = req.body;

    if (featured === undefined || featured === null) {
      return res.status(400).json({ success: false, error: 'featured (boolean) is required in request body' });
    }

    const { data: pack, error: packErr } = await supabase
      .from('pill_packs')
      .select('id, name, pack_type, is_vip, status')
      .eq('id', packId)
      .single();

    if (packErr || !pack) {
      return res.status(404).json({ success: false, error: 'Pack not found' });
    }

    // Block on Specials
    const isSpecial = pack.pack_type === 'special' || pack.is_vip;
    if (isSpecial) {
      return res.status(400).json({
        success: false,
        error: 'Cannot feature a Special pack — featured selection is for standard packs only',
      });
    }

    if (featured && pack.status !== 'active') {
      return res.status(400).json({
        success: false,
        error: 'Only active packs can be featured',
      });
    }

    // If setting featured: true, clear is_featured on all other standard packs first
    if (featured) {
      await supabase
        .from('pill_packs')
        .update({ is_featured: false })
        .or('pack_type.eq.standard,pack_type.is.null')
        .eq('is_vip', false)
        .neq('id', packId);
    }

    // Apply the new featured value
    const { data: updated, error: updateErr } = await supabase
      .from('pill_packs')
      .update({ is_featured: Boolean(featured) })
      .eq('id', packId)
      .select()
      .single();

    if (updateErr) {
      return res.status(500).json({ success: false, error: 'Failed to update featured status' });
    }

    return res.json({
      success: true,
      data: {
        pack: updated,
        message: featured ? `"${pack.name}" is now the featured pack` : `"${pack.name}" is no longer featured`,
      },
    });
  } catch (err) {
    console.error('Feature pack error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update featured status' });
  }
});

/**
 * PUT /api/admin/pills/packs/:packId
 * Update a pack's name, category, status, entry_fee, prize, or quiz_expires_at.
 * Body: { name?, category?, status?, entry_fee?, prize?, quiz_expires_at? }
 *
 * quiz_expires_at: set to null to clear, or an ISO timestamp to set/update.
 *   This is the Pills/Specials-only expiry — completely independent of entry_window_end.
 */
router.put('/packs/:packId', async (req, res) => {
  try {
    const { packId } = req.params;
    const { name, category, status, entry_fee, prize, is_vip,
            pack_type, question_count, total_time_seconds, required_correct, entry_window_end,
            quiz_expires_at } = req.body;

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (category !== undefined) updates.category = category;
    if (entry_fee !== undefined) updates.entry_fee = entry_fee === null ? null : Number(entry_fee);
    if (prize !== undefined) updates.prize = prize === null ? null : Number(prize);
    if (is_vip !== undefined) updates.is_vip = is_vip === true || is_vip === 'true';
    if (pack_type !== undefined) updates.pack_type = pack_type;
    if (question_count !== undefined) updates.question_count = question_count === null ? null : Number(question_count);
    if (total_time_seconds !== undefined) updates.total_time_seconds = total_time_seconds === null ? null : Number(total_time_seconds);
    if (required_correct !== undefined) updates.required_correct = required_correct === null ? null : Number(required_correct);
    if (entry_window_end !== undefined) updates.entry_window_end = entry_window_end === null ? null : new Date(entry_window_end).toISOString();
    // quiz_expires_at: Pills/Specials expiry — independent of entry_window_end
    if (quiz_expires_at !== undefined) updates.quiz_expires_at = quiz_expires_at === null ? null : new Date(quiz_expires_at).toISOString();
    if (status !== undefined) {
      if (!['active', 'inactive', 'draft'].includes(status)) {
        return res.status(400).json({ success: false, error: 'status must be active, inactive, or draft' });
      }
      updates.status = status;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No valid fields to update' });
    }

    // Special pack activation: enforce question_count minimum
    if (updates.status === 'active') {
      const { data: currentPack } = await supabase
        .from('pill_packs')
        .select('is_vip, pack_type, question_count')
        .eq('id', packId)
        .single();

      const isSpecial = currentPack?.pack_type === 'special' || currentPack?.is_vip;

      if (isSpecial) {
        const required = currentPack?.question_count || 10;
        const { count: pillCount } = await supabase
          .from('pills')
          .select('id', { count: 'exact', head: true })
          .eq('pack_id', packId)
          .eq('status', 'available')
          .is('deleted_at', null);   // exclude soft-deleted from activation count

        if ((pillCount || 0) < required) {
          return res.status(400).json({
            success: false,
            code: 'INSUFFICIENT_QUESTIONS',
            error: `Special packs need at least ${required} questions before activation. This pack has ${pillCount || 0}.`,
            current_count: pillCount || 0,
            required,
          });
        }

        // Warn (not block) if bank isn't meaningfully larger than question_count.
        // Recommendation: bank >= 3× question_count so overlap between attempts is uncommon.
        // Example: 10-question exam needs 30+ questions in the bank.
        const recommendedMin = required * 3;
        const warning = (pillCount || 0) < recommendedMin
          ? `Low entropy: bank has ${pillCount || 0} question(s) but needs at least ${recommendedMin} (3× question_count of ${required}) to keep overlap low between different players' attempts. Add ${Math.max(0, recommendedMin - (pillCount || 0))} more question(s).`
          : null;

        if (warning) {
          // Store warning for response — apply update first then return with warning
          const { data: updated, error: updateErr } = await supabase
            .from('pill_packs')
            .update({ ...updates })
            .eq('id', packId)
            .select()
            .single();

          if (updateErr || !updated) return res.status(404).json({ success: false, error: 'Pack not found or update failed' });
          return res.json({ success: true, warning, data: { pack: updated } });
        }
      }
    }

    const { data, error } = await supabase
      .from('pill_packs')
      .update(updates)
      .eq('id', packId)
      .select()
      .single();

    if (error || !data) return res.status(404).json({ success: false, error: 'Pack not found or update failed' });

    return res.json({ success: true, data: { pack: data } });
  } catch (err) {
    console.error('Update pack error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update pack' });
  }
});

/**
 * POST /api/admin/pills/packs/:packId/pills
 * Add a pill to a pack.
 * entry_fee and prize are optional if the pack has pack-level values set —
 * the pill will inherit from the pack. Explicit pill-level values override.
 * Body: { question, format, options?, correct_answer, timer?, entry_fee?, prize?, color? }
 */
router.post('/packs/:packId/pills', async (req, res) => {
  try {
    const { packId } = req.params;
    const { question, format, options, correct_answer, timer, entry_fee, prize, color, case_sensitive } = req.body;

    if (!question || !format || !correct_answer) {
      return res.status(400).json({
        success: false,
        error: 'question, format, and correct_answer are required',
      });
    }

    if (!['multiple_choice', 'type_answer'].includes(format)) {
      return res.status(400).json({ success: false, error: 'format must be multiple_choice or type_answer' });
    }

    // Fetch pack to get pack-level fee/prize as fallback
    const { data: pack } = await supabase
      .from('pill_packs')
      .select('id, entry_fee, prize')
      .eq('id', packId)
      .single();

    if (!pack) return res.status(404).json({ success: false, error: 'Pack not found' });

    // Resolve entry_fee and prize: explicit pill value takes priority, then pack-level
    const resolvedFee = entry_fee !== undefined ? Number(entry_fee) : (pack.entry_fee !== null ? Number(pack.entry_fee) : null);
    const resolvedPrize = prize !== undefined ? Number(prize) : (pack.prize !== null ? Number(pack.prize) : null);

    if (resolvedFee === null || resolvedPrize === null) {
      return res.status(400).json({
        success: false,
        error: 'entry_fee and prize are required — set them on the pill or on the pack',
      });
    }

    const { data, error } = await supabase
      .from('pills')
      .insert({
        admin_id: req.admin?.id || null,
        pack_id: packId,
        question,
        category: null,
        entry_fee: resolvedFee,
        prize: resolvedPrize,
        format,
        options: options || null,
        correct_answer,
        timer_seconds: timer || 30,
        color: color || '#00FF66',
        case_sensitive: case_sensitive ?? false,
        status: 'available',
      })
      .select()
      .single();

    if (error) return res.status(500).json({ success: false, error: 'Failed to create pill: ' + error.message });

    // Return the current bank entropy ratio so the admin UI can show it after each pill added
    const { count: currentBankSize } = await supabase
      .from('pills')
      .select('id', { count: 'exact', head: true })
      .eq('pack_id', packId)
      .eq('status', 'available');

    // Fetch pack's question_count for the ratio calculation
    const { data: packMeta } = await supabase
      .from('pill_packs')
      .select('question_count, pack_type, is_vip')
      .eq('id', packId)
      .single();

    const isSpecialPack = packMeta?.pack_type === 'special' || packMeta?.is_vip;
    const qc = packMeta?.question_count || null;
    const bankSize = currentBankSize || 0;
    const recommendedBankSize = qc ? qc * 3 : null;
    const bankRatio = qc && bankSize > 0 ? parseFloat((bankSize / qc).toFixed(2)) : null;
    let lowEntropyWarning = null;
    if (isSpecialPack && qc) {
      if (bankSize < qc) {
        lowEntropyWarning = `Bank (${bankSize}) is below question_count (${qc}) — pack cannot start yet.`;
      } else if (bankSize < qc * 3) {
        lowEntropyWarning = `Bank (${bankSize}) is less than 3× question_count (${qc}). Add ${Math.max(0, (qc * 3) - bankSize)} more to reach the recommended ${qc * 3}.`;
      }
    }

    return res.status(201).json({
      success: true,
      data: {
        pill: data,
        // ── Bank entropy summary (Specials only) ──────────────────────────
        bank_size: bankSize,
        question_count: qc,
        bank_ratio: bankRatio,
        recommended_bank_size: recommendedBankSize,
        low_entropy_warning: lowEntropyWarning,
      },
    });
  } catch (err) {
    console.error('Create pill in pack error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create pill' });
  }
});

/**
 * DELETE /api/admin/pills/packs/:packId
 * Soft-delete a pack (status → inactive) and expire all its pills.
 * Blocked if any pills still have status = 'available' — unless ?force=true is passed.
 *
 * ?force=true: hard-deletes the pack and all its pills from the DB.
 *   BLOCKED regardless if any real player plays exist (pill_plays.pack_id rows).
 *   Intended for test/dev pack cleanup only.
 */
router.delete('/packs/:packId', async (req, res) => {
  try {
    const { packId } = req.params;
    const force = req.query.force === 'true';

    // Confirm pack exists
    const { data: pack, error: packErr } = await supabase
      .from('pill_packs')
      .select('id, name, status')
      .eq('id', packId)
      .single();

    if (packErr || !pack) {
      return res.status(404).json({ success: false, error: 'Pack not found' });
    }

    // Always block if real player plays exist — protects transaction integrity regardless of force flag
    const packPillIds = await supabase
      .from('pills')
      .select('id')
      .eq('pack_id', packId);

    const pillIds = (packPillIds.data || []).map((p) => p.id);

    if (pillIds.length > 0) {
      const { count: realPlaysCount } = await supabase
        .from('pill_plays')
        .select('id', { count: 'exact', head: true })
        .in('pill_id', pillIds);

      if ((realPlaysCount || 0) > 0) {
        return res.status(409).json({
          success: false,
          code: 'HAS_REAL_PLAYS',
          error: `Cannot delete pack — ${realPlaysCount} real player play${realPlaysCount === 1 ? '' : 's'} exist. This pack has live data and cannot be deleted.`,
          real_plays_count: realPlaysCount,
        });
      }
    }

    // Force hard-delete — removes pills and pack entirely from DB
    if (force) {
      if (pillIds.length > 0) {
        await supabase.from('pills').delete().eq('pack_id', packId);
      }
      await supabase.from('pill_packs').delete().eq('id', packId);

      return res.json({
        success: true,
        data: { message: `Pack "${pack.name}" permanently deleted (${pillIds.length} pill${pillIds.length === 1 ? '' : 's'} removed)` },
      });
    }

    // Standard soft-delete — blocked if available pills remain
    const { count: availableCount, error: countErr } = await supabase
      .from('pills')
      .select('id', { count: 'exact', head: true })
      .eq('pack_id', packId)
      .eq('status', 'available');

    if (countErr) {
      return res.status(500).json({ success: false, error: 'Failed to check pill status' });
    }

    if (availableCount > 0) {
      return res.status(409).json({
        success: false,
        code: 'HAS_UNPLAYED_PILLS',
        error: `Cannot delete pack — ${availableCount} unplayed pill${availableCount === 1 ? '' : 's'} remaining. Expire them first, or use ?force=true to hard-delete (only if no real player plays exist).`,
        available_count: availableCount,
      });
    }

    // Soft-delete: expire remaining pills, mark pack inactive
    if (pillIds.length > 0) {
      await supabase
        .from('pills')
        .update({ status: 'expired' })
        .eq('pack_id', packId)
        .neq('status', 'expired');
    }

    const { error: packUpdateErr } = await supabase
      .from('pill_packs')
      .update({ status: 'inactive' })
      .eq('id', packId);

    if (packUpdateErr) {
      return res.status(500).json({ success: false, error: 'Failed to delete pack' });
    }

    return res.json({
      success: true,
      data: { message: `Pack "${pack.name}" deleted` },
    });
  } catch (err) {
    console.error('Delete pack error:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete pack' });
  }
});

// ─── INDIVIDUAL PILL ROUTES ───────────────────────────────────────────────────

/**
 * GET /api/admin/pills/stats
 * Pill statistics and analytics
 */
router.get('/stats', async (req, res) => {
  try {
    const [
      totalPacksRes,
      activePacksRes,
      totalPillsRes,
      availablePillsRes,
      expiredPillsRes,
      totalPlaysRes,
      totalWinsRes,
    ] = await Promise.all([
      supabase.from('pill_packs').select('id', { count: 'exact', head: true }),
      supabase.from('pill_packs').select('id', { count: 'exact', head: true }).eq('status', 'active'),
      supabase.from('pills').select('id', { count: 'exact', head: true }).is('deleted_at', null),
      supabase.from('pills').select('id', { count: 'exact', head: true }).eq('status', 'available').is('deleted_at', null),
      supabase.from('pills').select('id', { count: 'exact', head: true }).eq('status', 'expired').is('deleted_at', null),
      supabase.from('pill_plays').select('id', { count: 'exact', head: true }),
      supabase.from('pill_plays').select('id', { count: 'exact', head: true }).eq('won', true),
    ]);

    const stats = {
      totalPacks: totalPacksRes.count || 0,
      activePacks: activePacksRes.count || 0,
      totalPills: totalPillsRes.count || 0,
      availablePills: availablePillsRes.count || 0,
      expiredPills: expiredPillsRes.count || 0,
      totalPlays: totalPlaysRes.count || 0,
      totalWins: totalWinsRes.count || 0,
    };

    return res.json({ success: true, data: { stats } });
  } catch (err) {
    console.error('Pills stats error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch pill stats' });
  }
});

/**
 * GET /api/admin/pills/packs/:packId/pills
 * List all non-deleted pills for a specific pack (paginated, admin view).
 * Includes available, played, and expired — excludes soft-deleted.
 * Query: ?page=1&limit=20&status=available
 */
router.get('/packs/:packId/pills', async (req, res) => {
  try {
    const { packId } = req.params;
    const { page = 1, limit = 20, status } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    // Confirm pack exists
    const { data: pack, error: packErr } = await supabase
      .from('pill_packs')
      .select('id, name, question_count, pack_type, is_vip')
      .eq('id', packId)
      .single();

    if (packErr || !pack) {
      return res.status(404).json({ success: false, error: 'Pack not found' });
    }

    let query = supabase
      .from('pills')
      .select('id, pack_id, question, format, options, correct_answer, timer_seconds, color, case_sensitive, entry_fee, prize, status, deleted_at, created_at, updated_at', { count: 'exact' })
      .eq('pack_id', packId)
      .is('deleted_at', null)           // exclude soft-deleted
      .order('created_at', { ascending: true })
      .range(offset, offset + Number(limit) - 1);

    if (status) query = query.eq('status', status);

    const { data: pills, error, count } = await query;

    if (error) {
      return res.status(500).json({ success: false, error: 'Failed to fetch pills' });
    }

    // Bank entropy summary
    const isSpecial = pack.pack_type === 'special' || pack.is_vip;
    const qc = pack.question_count;
    const availableCount = (pills || []).filter((p) => p.status === 'available').length;
    let bankRatio = null;
    let lowEntropyWarning = null;
    if (isSpecial && qc) {
      bankRatio = availableCount > 0 ? parseFloat((availableCount / qc).toFixed(2)) : 0;
      if (availableCount < qc * 3) {
        lowEntropyWarning = availableCount < qc
          ? `Bank (${availableCount}) is below question_count (${qc}) — pack cannot start.`
          : `Bank (${availableCount}) is less than 3× question_count (${qc}). Recommend ${qc * 3}+ questions.`;
      }
    }

    return res.json({
      success: true,
      data: {
        pills: pills || [],
        total: count || 0,
        page: Number(page),
        limit: Number(limit),
        pack_id: packId,
        bank_ratio: bankRatio,
        low_entropy_warning: lowEntropyWarning,
      },
    });
  } catch (err) {
    console.error('Get pack pills error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch pills' });
  }
});

/**
 * GET /api/admin/pills
 * List all non-deleted pills (paginated, cross-pack)
 */
router.get('/', async (req, res) => {
  try {
    const { status, category, pack_id, page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let query = supabase
      .from('pills')
      .select('*', { count: 'exact' })
      .is('deleted_at', null)           // exclude soft-deleted
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (status) query = query.eq('status', status);
    if (category) query = query.eq('category', category);
    if (pack_id) query = query.eq('pack_id', pack_id);

    const { data, error, count } = await query;

    if (error) return res.status(500).json({ success: false, error: 'Failed to fetch pills' });

    return res.json({ success: true, data: { pills: data, total: count, page: Number(page), limit: Number(limit) } });
  } catch (err) {
    console.error('Get pills error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch pills' });
  }
});

/**
 * POST /api/admin/pills
 * Create a standalone pill (no pack)
 */
router.post('/', async (req, res) => {
  try {
    const { question, category, entry_fee, prize, format, options, correct_answer, timer_seconds, case_sensitive, color, pack_id } = req.body;

    if (!question || !format || !correct_answer || entry_fee === undefined || prize === undefined) {
      return res.status(400).json({
        success: false,
        error: 'question, format, correct_answer, entry_fee, and prize are required',
      });
    }

    if (!['multiple_choice', 'type_answer'].includes(format)) {
      return res.status(400).json({ success: false, error: 'format must be multiple_choice or type_answer' });
    }

    const { data, error } = await supabase
      .from('pills')
      .insert({
        admin_id: req.admin?.id || null,
        pack_id: pack_id || null,
        question,
        category: category || 'General',
        entry_fee: Number(entry_fee),
        prize: Number(prize),
        format,
        options: options || null,
        correct_answer,
        timer_seconds: timer_seconds || 30,
        color: color || '#00FF66',
        case_sensitive: case_sensitive ?? false,
        status: 'available',
      })
      .select()
      .single();

    if (error) return res.status(500).json({ success: false, error: 'Failed to create pill' });

    return res.status(201).json({ success: true, data: { pill: data } });
  } catch (err) {
    console.error('Create pill error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create pill' });
  }
});

/**
 * PATCH /api/admin/pills/:id
 * Edit an existing pill's question text, options, correct_answer, format,
 * timer_seconds, color, or case_sensitive.
 *
 * BLOCKED if the pill is currently assigned to any in-progress special attempt
 * (i.e. a player is mid-exam with this question). This prevents an admin from
 * changing the correct answer under a player who is actively answering.
 *
 * Strategy: block-while-in-progress (simpler than versioning given current schema).
 *
 * Body: { question?, format?, options?, correct_answer?, timer_seconds?,
 *         color?, case_sensitive? }
 */
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { question, format, options, correct_answer, timer_seconds, color, case_sensitive } = req.body;

    // Fetch the pill — must exist and not be soft-deleted
    const { data: pill, error: pillErr } = await supabase
      .from('pills')
      .select('id, pack_id, status, deleted_at')
      .eq('id', id)
      .single();

    if (pillErr || !pill) {
      return res.status(404).json({ success: false, error: 'Pill not found' });
    }
    if (pill.deleted_at) {
      return res.status(409).json({ success: false, error: 'Cannot edit a deleted question' });
    }

    // Block edit if this pill is inside any active in-progress attempt.
    // special_attempts.question_ids is a JSONB array of pill UUIDs.
    // The @> operator checks if the array contains this pill's ID.
    const { count: activeAttemptCount, error: attemptCheckErr } = await supabase
      .from('special_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'in_progress')
      .contains('question_ids', JSON.stringify([id]));

    if (attemptCheckErr) {
      console.error('Pill edit — attempt check error:', attemptCheckErr);
      return res.status(500).json({ success: false, error: 'Failed to check active attempts' });
    }

    if ((activeAttemptCount || 0) > 0) {
      return res.status(409).json({
        success: false,
        code: 'PILL_IN_ACTIVE_ATTEMPT',
        error: `Cannot edit this question — it is currently in ${activeAttemptCount} active attempt(s). Wait for those attempts to complete or time out, then retry.`,
        active_attempt_count: activeAttemptCount,
      });
    }

    // Build update — only allow safe, content-level fields
    const updates = {};
    if (question !== undefined)       updates.question       = question;
    if (format !== undefined)         updates.format         = format;
    if (options !== undefined)        updates.options        = options;
    if (correct_answer !== undefined) updates.correct_answer = correct_answer;
    if (timer_seconds !== undefined)  updates.timer_seconds  = Number(timer_seconds);
    if (color !== undefined)          updates.color          = color;
    if (case_sensitive !== undefined) updates.case_sensitive = case_sensitive;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No valid fields to update' });
    }

    if (format !== undefined && !['multiple_choice', 'type_answer'].includes(format)) {
      return res.status(400).json({ success: false, error: 'format must be multiple_choice or type_answer' });
    }

    updates.updated_at = new Date().toISOString();

    const { data: updated, error: updateErr } = await supabase
      .from('pills')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (updateErr || !updated) {
      return res.status(500).json({ success: false, error: 'Failed to update pill' });
    }

    return res.json({ success: true, data: { pill: updated } });
  } catch (err) {
    console.error('Patch pill error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update pill' });
  }
});

/**
 * PUT /api/admin/pills/:id
 * Full update of a pill (legacy endpoint — kept for backward compatibility).
 * Prefer PATCH for question-bank edits.
 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    delete updates.id;
    delete updates.admin_id;
    delete updates.created_at;
    delete updates.deleted_at;     // never allow un-deleting via PUT

    const { data, error } = await supabase
      .from('pills')
      .update(updates)
      .eq('id', id)
      .is('deleted_at', null)       // refuse to touch soft-deleted pills
      .select()
      .single();

    if (error || !data) return res.status(404).json({ success: false, error: 'Pill not found or update failed' });

    return res.json({ success: true, data: { pill: data } });
  } catch (err) {
    console.error('Update pill error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update pill' });
  }
});

/**
 * DELETE /api/admin/pills/:id
 * Soft-delete a pill from the question bank.
 *
 * Sets deleted_at = NOW(). The row stays in the DB so historical
 * special_attempts that included this pill remain fully auditable
 * and their grading/scoring is not affected.
 *
 * The pill is excluded from:
 *   - All future attempt bank draws (sampling queries filter deleted_at IS NULL)
 *   - All admin list endpoints
 *   - All player-facing pack/specials queries
 *
 * Hard-delete is intentionally not supported — use ?force=true on the PACK
 * delete endpoint if you need to remove an entire pack with no player plays.
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Confirm pill exists and isn't already deleted
    const { data: pill, error: pillErr } = await supabase
      .from('pills')
      .select('id, deleted_at, status')
      .eq('id', id)
      .single();

    if (pillErr || !pill) {
      return res.status(404).json({ success: false, error: 'Pill not found' });
    }

    if (pill.deleted_at) {
      return res.status(409).json({ success: false, error: 'Pill is already deleted' });
    }

    // Soft-delete: stamp deleted_at, keep the row intact
    const { error: deleteErr } = await supabase
      .from('pills')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id);

    if (deleteErr) {
      return res.status(500).json({ success: false, error: 'Failed to delete pill' });
    }

    return res.json({
      success: true,
      data: { message: 'Pill removed from question bank (soft-deleted — historical attempts unaffected)' },
    });
  } catch (err) {
    console.error('Delete pill error:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete pill' });
  }
});

module.exports = router;
