const express = require('express');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const multer = require('multer');
const supabase = require('../db/supabase');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Apply admin auth to all routes in this file
router.use(adminAuth);

// ─── STATS ────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/stats
 * Returns: plays today, revenue today, payouts today, profit today
 */
router.get('/stats', async (req, res) => {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [playsRes, sessionsRes] = await Promise.all([
      supabase
        .from('game_sessions')
        .select('id, status, entry_fee, prize', { count: 'exact' })
        .gte('played_at', startOfDay.toISOString()),
      supabase
        .from('game_sessions')
        .select('entry_fee, prize, status')
        .gte('played_at', startOfDay.toISOString()),
    ]);

    const sessions = sessionsRes.data || [];
    const playsToday = playsRes.count || 0;
    const revenueToday = sessions.reduce((sum, s) => sum + (s.entry_fee || 0), 0);
    const payoutsToday = sessions
      .filter((s) => s.status === 'won')
      .reduce((sum, s) => sum + (s.prize || 0), 0);
    const profitToday = revenueToday - payoutsToday;

    // Total players
    const { count: totalPlayers } = await supabase
      .from('players')
      .select('id', { count: 'exact', head: true });

    // Pending withdrawals
    const { count: pendingWithdrawals } = await supabase
      .from('withdrawal_requests')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending');

    return res.json({
      success: true,
      data: {
        playsToday,
        revenueToday,
        payoutsToday,
        profitToday,
        totalPlayers,
        pendingWithdrawals,
      },
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch stats' });
  }
});

// ─── QUESTIONS ────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/questions
 */
router.get('/questions', async (req, res) => {
  try {
    const { search, door_id, format, difficulty, status, page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let query = supabase
      .from('questions')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (search) query = query.ilike('text', `%${search}%`);
    if (door_id) query = query.eq('door_id', door_id);
    if (format) query = query.eq('format', format);
    if (difficulty) query = query.eq('difficulty', difficulty);
    if (status) query = query.eq('status', status);
    else query = query.neq('status', 'deleted');

    const { data, error, count } = await query;

    if (error) return res.status(500).json({ success: false, error: 'Failed to fetch questions' });

    return res.json({ success: true, data: { questions: data, total: count, page: Number(page), limit: Number(limit) } });
  } catch (err) {
    console.error('Get questions error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch questions' });
  }
});

/**
 * POST /api/admin/questions
 */
router.post('/questions', async (req, res) => {
  try {
    const { door_id, text, format, difficulty, prize, time_limit, options, correct_answer, case_sensitive, spelling_tolerance } = req.body;

    if (!text || !format || !correct_answer || !prize) {
      return res.status(400).json({ success: false, error: 'text, format, correct_answer, and prize are required' });
    }

    if (!['multiple_choice', 'type_answer'].includes(format)) {
      return res.status(400).json({ success: false, error: 'format must be multiple_choice or type_answer' });
    }

    const { data, error } = await supabase
      .from('questions')
      .insert({
        door_id,
        text,
        format,
        difficulty,
        prize: Number(prize),
        time_limit: time_limit || 10,
        options: options || null,
        correct_answer,
        case_sensitive: case_sensitive ?? false,
        spelling_tolerance: spelling_tolerance || 'strict',
        status: 'active',
      })
      .select()
      .single();

    if (error) return res.status(500).json({ success: false, error: 'Failed to create question' });

    return res.status(201).json({ success: true, data: { question: data } });
  } catch (err) {
    console.error('Create question error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create question' });
  }
});

/**
 * PUT /api/admin/questions/:id
 */
router.put('/questions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Prevent updating certain fields
    delete updates.id;
    delete updates.created_at;

    const { data, error } = await supabase
      .from('questions')
      .update(updates)
      .eq('id', id)
      .neq('status', 'deleted')
      .select()
      .single();

    if (error || !data) return res.status(404).json({ success: false, error: 'Question not found or update failed' });

    return res.json({ success: true, data: { question: data } });
  } catch (err) {
    console.error('Update question error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update question' });
  }
});

/**
 * DELETE /api/admin/questions/:id — soft delete
 */
router.delete('/questions/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('questions')
      .update({ status: 'deleted' })
      .eq('id', id);

    if (error) return res.status(500).json({ success: false, error: 'Failed to delete question' });

    return res.json({ success: true, data: { message: 'Question deleted' } });
  } catch (err) {
    console.error('Delete question error:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete question' });
  }
});

/**
 * POST /api/admin/questions/import — CSV or JSON bulk upload
 */
router.post('/questions/import', upload.single('file'), async (req, res) => {
  try {
    let questions = [];

    if (req.file) {
      const content = req.file.buffer.toString('utf-8');
      const mime = req.file.mimetype;

      if (mime === 'application/json' || req.file.originalname.endsWith('.json')) {
        questions = JSON.parse(content);
      } else {
        // CSV
        const records = parse(content, { columns: true, skip_empty_lines: true, trim: true });
        questions = records.map((r) => ({
          ...r,
          prize: Number(r.prize),
          time_limit: r.time_limit ? Number(r.time_limit) : 10,
          case_sensitive: r.case_sensitive === 'true',
          options: r.options ? JSON.parse(r.options) : null,
        }));
      }
    } else if (req.body.questions) {
      questions = Array.isArray(req.body.questions) ? req.body.questions : JSON.parse(req.body.questions);
    }

    if (!questions.length) {
      return res.status(400).json({ success: false, error: 'No questions provided' });
    }

    const toInsert = questions.map((q) => ({
      door_id: q.door_id || null,
      text: q.text,
      format: q.format,
      difficulty: q.difficulty || null,
      prize: Number(q.prize),
      time_limit: q.time_limit || 10,
      options: q.options || null,
      correct_answer: q.correct_answer,
      case_sensitive: q.case_sensitive ?? false,
      spelling_tolerance: q.spelling_tolerance || 'strict',
      status: 'active',
    }));

    const { data, error } = await supabase.from('questions').insert(toInsert).select();

    if (error) return res.status(500).json({ success: false, error: 'Bulk import failed: ' + error.message });

    return res.status(201).json({ success: true, data: { imported: data.length, questions: data } });
  } catch (err) {
    console.error('Import questions error:', err);
    return res.status(500).json({ success: false, error: 'Failed to import questions' });
  }
});

// ─── DOORS ────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/doors
 */
router.get('/doors', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('doors')
      .select(`
        id, status, prize, entry_fee, question_id,
        questions ( id, text, format, difficulty, prize, status )
      `)
      .order('id');

    if (error) return res.status(500).json({ success: false, error: 'Failed to fetch doors' });

    return res.json({ success: true, data: { doors: data } });
  } catch (err) {
    console.error('Get doors error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch doors' });
  }
});

/**
 * PUT /api/admin/doors/:id
 */
router.put('/doors/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { question_id, entry_fee, status, prize } = req.body;

    const updates = {};
    if (question_id !== undefined) updates.question_id = question_id;
    if (entry_fee !== undefined) updates.entry_fee = Number(entry_fee);
    if (status !== undefined) updates.status = status;
    if (prize !== undefined) updates.prize = Number(prize);

    const { data, error } = await supabase
      .from('doors')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error || !data) return res.status(404).json({ success: false, error: 'Door not found or update failed' });

    return res.json({ success: true, data: { door: data } });
  } catch (err) {
    console.error('Update door error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update door' });
  }
});

// ─── PLAYERS ─────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/players
 */
router.get('/players', async (req, res) => {
  try {
    const { search, status, page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let query = supabase
      .from('players')
      .select('id, phone, name, balance, games_played, games_won, total_won, status, created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (search) query = query.ilike('phone', `%${search}%`);
    if (status) query = query.eq('status', status);

    const { data, error, count } = await query;

    if (error) return res.status(500).json({ success: false, error: 'Failed to fetch players' });

    return res.json({ success: true, data: { players: data, total: count, page: Number(page), limit: Number(limit) } });
  } catch (err) {
    console.error('Get players error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch players' });
  }
});

/**
 * PUT /api/admin/players/:id/ban — toggle ban
 */
router.put('/players/:id/ban', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: player } = await supabase.from('players').select('status').eq('id', id).single();

    if (!player) return res.status(404).json({ success: false, error: 'Player not found' });

    const newStatus = player.status === 'banned' ? 'active' : 'banned';

    const { data, error } = await supabase
      .from('players')
      .update({ status: newStatus })
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(500).json({ success: false, error: 'Failed to update player status' });

    return res.json({ success: true, data: { player: data, message: `Player ${newStatus}` } });
  } catch (err) {
    console.error('Ban player error:', err);
    return res.status(500).json({ success: false, error: 'Failed to toggle ban status' });
  }
});

// ─── SETTINGS ─────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/settings
 */
router.get('/settings', async (req, res) => {
  try {
    const { data, error } = await supabase.from('app_settings').select('*').eq('id', 1).single();

    if (error) return res.status(500).json({ success: false, error: 'Failed to fetch settings' });

    return res.json({ success: true, data: { settings: data } });
  } catch (err) {
    console.error('Get settings error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch settings' });
  }
});

/**
 * PUT /api/admin/settings
 */
router.put('/settings', async (req, res) => {
  try {
    const updates = req.body;

    // Prevent changing ID or kill switch via this route
    delete updates.id;
    delete updates.game_kill_switch;

    const { data, error } = await supabase
      .from('app_settings')
      .update(updates)
      .eq('id', 1)
      .select()
      .single();

    if (error) return res.status(500).json({ success: false, error: 'Failed to update settings' });

    return res.json({ success: true, data: { settings: data } });
  } catch (err) {
    console.error('Update settings error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update settings' });
  }
});

/**
 * POST /api/admin/kill-switch
 * Toggle game kill switch on/off.
 */
router.post('/kill-switch', async (req, res) => {
  try {
    const { data: current } = await supabase
      .from('app_settings')
      .select('game_kill_switch')
      .eq('id', 1)
      .single();

    const newState = !current?.game_kill_switch;

    const { data, error } = await supabase
      .from('app_settings')
      .update({ game_kill_switch: newState })
      .eq('id', 1)
      .select('game_kill_switch')
      .single();

    if (error) return res.status(500).json({ success: false, error: 'Failed to toggle kill switch' });

    return res.json({
      success: true,
      data: { gameKillSwitch: data.game_kill_switch, message: `Game ${data.game_kill_switch ? 'disabled' : 'enabled'}` },
    });
  } catch (err) {
    console.error('Kill switch error:', err);
    return res.status(500).json({ success: false, error: 'Failed to toggle kill switch' });
  }
});

// ─── ANALYTICS ────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/analytics/revenue
 * Hourly or daily revenue data.
 * Query: ?period=daily|hourly&days=7
 */
router.get('/analytics/revenue', async (req, res) => {
  try {
    const { period = 'daily', days = 7 } = req.query;
    const since = new Date();
    since.setDate(since.getDate() - Number(days));

    const { data, error } = await supabase
      .from('game_sessions')
      .select('entry_fee, prize, status, played_at')
      .gte('played_at', since.toISOString());

    if (error) return res.status(500).json({ success: false, error: 'Failed to fetch revenue data' });

    // Group by hour or day
    const groups = {};
    for (const session of data) {
      const date = new Date(session.played_at);
      const key =
        period === 'hourly'
          ? `${date.toISOString().slice(0, 13)}:00`
          : date.toISOString().slice(0, 10);

      if (!groups[key]) groups[key] = { period: key, revenue: 0, payouts: 0, profit: 0, plays: 0 };
      groups[key].revenue += session.entry_fee || 0;
      groups[key].plays += 1;
      if (session.status === 'won') groups[key].payouts += session.prize || 0;
    }

    for (const key of Object.keys(groups)) {
      groups[key].profit = groups[key].revenue - groups[key].payouts;
    }

    const result = Object.values(groups).sort((a, b) => a.period.localeCompare(b.period));

    return res.json({ success: true, data: { revenue: result } });
  } catch (err) {
    console.error('Revenue analytics error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch revenue analytics' });
  }
});

/**
 * GET /api/admin/analytics/doors
 * Door popularity stats.
 */
router.get('/analytics/doors', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('game_sessions')
      .select('door_id, status, prize, entry_fee');

    if (error) return res.status(500).json({ success: false, error: 'Failed to fetch door analytics' });

    const doors = {};
    for (const s of data) {
      const id = s.door_id;
      if (!doors[id]) doors[id] = { doorId: id, plays: 0, wins: 0, revenue: 0, payouts: 0 };
      doors[id].plays += 1;
      doors[id].revenue += s.entry_fee || 0;
      if (s.status === 'won') {
        doors[id].wins += 1;
        doors[id].payouts += s.prize || 0;
      }
    }

    return res.json({ success: true, data: { doors: Object.values(doors) } });
  } catch (err) {
    console.error('Door analytics error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch door analytics' });
  }
});

/**
 * GET /api/admin/analytics/activity
 * Hourly player activity (plays per hour across last 24h).
 */
router.get('/analytics/activity', async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const { data, error } = await supabase
      .from('game_sessions')
      .select('played_at')
      .gte('played_at', since.toISOString());

    if (error) return res.status(500).json({ success: false, error: 'Failed to fetch activity data' });

    const hours = {};
    for (const s of data) {
      const hour = new Date(s.played_at).toISOString().slice(0, 13) + ':00';
      hours[hour] = (hours[hour] || 0) + 1;
    }

    const result = Object.entries(hours)
      .map(([hour, plays]) => ({ hour, plays }))
      .sort((a, b) => a.hour.localeCompare(b.hour));

    return res.json({ success: true, data: { activity: result } });
  } catch (err) {
    console.error('Activity analytics error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch activity analytics' });
  }
});

// ─── EXPORT ───────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/export
 * Export full report as CSV.
 */
router.get('/export', async (req, res) => {
  try {
    const { type = 'sessions', days = 30 } = req.query;
    const since = new Date();
    since.setDate(since.getDate() - Number(days));

    let data = [];
    let filename = 'report';

    if (type === 'sessions') {
      const { data: sessions } = await supabase
        .from('game_sessions')
        .select('id, phone, door_id, status, player_answer, correct_answer, prize, entry_fee, played_at')
        .gte('played_at', since.toISOString())
        .order('played_at', { ascending: false });
      data = sessions || [];
      filename = 'game_sessions';
    } else if (type === 'players') {
      const { data: players } = await supabase
        .from('players')
        .select('id, phone, name, balance, games_played, games_won, total_won, status, created_at');
      data = players || [];
      filename = 'players';
    } else if (type === 'withdrawals') {
      const { data: withdrawals } = await supabase
        .from('withdrawal_requests')
        .select('id, phone, amount, method, account_number, bank_name, status, created_at')
        .order('created_at', { ascending: false });
      data = withdrawals || [];
      filename = 'withdrawals';
    }

    if (!data.length) {
      return res.json({ success: true, data: { message: 'No data found' } });
    }

    const csv = stringify(data, { header: true });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}_${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.send(csv);
  } catch (err) {
    console.error('Export error:', err);
    return res.status(500).json({ success: false, error: 'Export failed' });
  }
});

module.exports = router;
