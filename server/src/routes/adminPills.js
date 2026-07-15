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
      return {
        ...pack,
        pills: packPills,
        available_count: packPills.filter((p) => p.status === 'available').length,
        played_count: packPills.filter((p) => p.status === 'played').length,
        expired_count: packPills.filter((p) => p.status === 'expired').length,
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
 * Body: { name, category, status?, entry_fee?, prize? }
 * entry_fee and prize are pack-level — all pills in this pack share these values.
 */
router.post('/packs', async (req, res) => {
  try {
    const {
      name, category, status, entry_fee, prize, is_vip,
      pack_type, question_count, total_time_seconds, required_correct, entry_window_end,
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
 * PUT /api/admin/pills/packs/:packId
 * Update a pack's name, category, status, entry_fee, or prize
 * Body: { name?, category?, status?, entry_fee?, prize? }
 */
router.put('/packs/:packId', async (req, res) => {
  try {
    const { packId } = req.params;
    const { name, category, status, entry_fee, prize, is_vip,
            pack_type, question_count, total_time_seconds, required_correct, entry_window_end } = req.body;

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
          .eq('status', 'available');

        if ((pillCount || 0) < required) {
          return res.status(400).json({
            success: false,
            code: 'INSUFFICIENT_QUESTIONS',
            error: `Special packs need at least ${required} questions before activation. This pack has ${pillCount || 0}.`,
            current_count: pillCount || 0,
            required,
          });
        }

        // Warn (not block) if bank isn't meaningfully larger than question_count
        const warning = (pillCount || 0) < required * 2
          ? `Question bank (${pillCount}) is less than 2× question_count (${required}). Consider adding more for better per-player randomization.`
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

    return res.status(201).json({ success: true, data: { pill: data } });
  } catch (err) {
    console.error('Create pill in pack error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create pill' });
  }
});

/**
 * DELETE /api/admin/pills/packs/:packId
 * Soft-delete a pack (status → inactive) and expire all its pills.
 * Blocked if any pills in the pack still have status = 'available'.
 * Mirrors the frontend safety check server-side — destructive actions must
 * be validated here regardless of what the client does.
 */
router.delete('/packs/:packId', async (req, res) => {
  try {
    const { packId } = req.params;

    // Confirm pack exists
    const { data: pack, error: packErr } = await supabase
      .from('pill_packs')
      .select('id, name, status')
      .eq('id', packId)
      .single();

    if (packErr || !pack) {
      return res.status(404).json({ success: false, error: 'Pack not found' });
    }

    // Safety check: reject if any pills are still available (unplayed)
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
        error: `Cannot delete pack — ${availableCount} unplayed pill${availableCount === 1 ? '' : 's'} remaining. Expire or remove them first.`,
        available_count: availableCount,
      });
    }

    // Soft-delete: expire all pills in the pack, then mark pack inactive
    await supabase
      .from('pills')
      .update({ status: 'expired' })
      .eq('pack_id', packId)
      .neq('status', 'expired'); // no-op on already-expired pills

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
      supabase.from('pills').select('id', { count: 'exact', head: true }),
      supabase.from('pills').select('id', { count: 'exact', head: true }).eq('status', 'available'),
      supabase.from('pills').select('id', { count: 'exact', head: true }).eq('status', 'expired'),
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
 * GET /api/admin/pills
 * List all pills (paginated)
 */
router.get('/', async (req, res) => {
  try {
    const { status, category, pack_id, page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let query = supabase
      .from('pills')
      .select('*', { count: 'exact' })
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
 * PUT /api/admin/pills/:id
 * Update a pill
 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    delete updates.id;
    delete updates.admin_id;
    delete updates.created_at;

    const { data, error } = await supabase.from('pills').update(updates).eq('id', id).select().single();

    if (error || !data) return res.status(404).json({ success: false, error: 'Pill not found or update failed' });

    return res.json({ success: true, data: { pill: data } });
  } catch (err) {
    console.error('Update pill error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update pill' });
  }
});

/**
 * DELETE /api/admin/pills/:id
 * Mark pill as expired
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase.from('pills').update({ status: 'expired' }).eq('id', id);

    if (error) return res.status(500).json({ success: false, error: 'Failed to delete pill' });

    return res.json({ success: true, data: { message: 'Pill marked as expired' } });
  } catch (err) {
    console.error('Delete pill error:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete pill' });
  }
});

module.exports = router;
