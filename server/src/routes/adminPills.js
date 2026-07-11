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
 * Body: { name, category, status? }
 */
router.post('/packs', async (req, res) => {
  try {
    const { name, category, status } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }

    const { data, error } = await supabase
      .from('pill_packs')
      .insert({
        name,
        category: category || 'General',
        status: status || 'draft',
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
 * Update a pack's name, category, or status
 * Body: { name?, category?, status? }
 */
router.put('/packs/:packId', async (req, res) => {
  try {
    const { packId } = req.params;
    const { name, category, status } = req.body;

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (category !== undefined) updates.category = category;
    if (status !== undefined) {
      if (!['active', 'inactive', 'draft'].includes(status)) {
        return res.status(400).json({ success: false, error: 'status must be active, inactive, or draft' });
      }
      updates.status = status;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No valid fields to update' });
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
 * Add a pill to a pack
 * Body: { question, format, options?, correct_answer, timer?, entry_fee, prize, color? }
 */
router.post('/packs/:packId/pills', async (req, res) => {
  try {
    const { packId } = req.params;
    const { question, format, options, correct_answer, timer, entry_fee, prize, color, case_sensitive } = req.body;

    if (!question || !format || !correct_answer || entry_fee === undefined || prize === undefined) {
      return res.status(400).json({
        success: false,
        error: 'question, format, correct_answer, entry_fee, and prize are required',
      });
    }

    if (!['multiple_choice', 'type_answer'].includes(format)) {
      return res.status(400).json({ success: false, error: 'format must be multiple_choice or type_answer' });
    }

    // Verify pack exists
    const { data: pack } = await supabase.from('pill_packs').select('id').eq('id', packId).single();
    if (!pack) return res.status(404).json({ success: false, error: 'Pack not found' });

    const { data, error } = await supabase
      .from('pills')
      .insert({
        admin_id: req.admin?.id || null,
        pack_id: packId,
        question,
        category: null,
        entry_fee: Number(entry_fee),
        prize: Number(prize),
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
