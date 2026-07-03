const express = require('express');
const supabase = require('../db/supabase');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();

// Apply admin auth to all routes in this file
router.use(adminAuth);

/**
 * GET /api/admin/pills
 * List all pills (paginated)
 */
router.get('/', async (req, res) => {
  try {
    const { status, category, page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let query = supabase
      .from('pills')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (status) query = query.eq('status', status);
    if (category) query = query.eq('category', category);

    const { data, error, count } = await query;

    if (error) return res.status(500).json({ success: false, error: 'Failed to fetch pills' });

    return res.json({
      success: true,
      data: {
        pills: data,
        total: count,
        page: Number(page),
        limit: Number(limit),
      },
    });
  } catch (err) {
    console.error('Get pills error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch pills' });
  }
});

/**
 * POST /api/admin/pills
 * Create a new pill
 */
router.post('/', async (req, res) => {
  try {
    const { question, category, entry_fee, prize, format, options, correct_answer, timer_seconds, case_sensitive } = req.body;

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
        admin_id: req.admin.id,
        question,
        category: category || 'General',
        entry_fee: Number(entry_fee),
        prize: Number(prize),
        format,
        options: options || null,
        correct_answer,
        timer_seconds: timer_seconds || 30,
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

    // Prevent updating these fields
    delete updates.id;
    delete updates.admin_id;
    delete updates.created_at;

    const { data, error } = await supabase
      .from('pills')
      .update(updates)
      .eq('id', id)
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
 * Mark pill as expired or delete it
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

/**
 * GET /api/admin/pills/stats
 * Pill statistics and analytics
 */
router.get('/stats', async (req, res) => {
  try {
    const { data: allPills } = await supabase.from('pills').select('*');

    const stats = {
      total: allPills?.length || 0,
      available: allPills?.filter((p) => p.status === 'available').length || 0,
      played: allPills?.filter((p) => p.status === 'played').length || 0,
      expired: allPills?.filter((p) => p.status === 'expired').length || 0,
      totalRevenueGenerated: allPills?.reduce((sum, p) => sum + (parseFloat(p.entry_fee) || 0), 0) || 0,
      totalPrizeDistributed: allPills?.reduce((sum, p) => sum + (parseFloat(p.prize) || 0), 0) || 0,
    };

    return res.json({ success: true, data: { stats } });
  } catch (err) {
    console.error('Pills stats error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch pill stats' });
  }
});

module.exports = router;
