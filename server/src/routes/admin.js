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
 * GET /api/admin/analytics/overview
 * Unified analytics overview for the dashboard analytics page.
 * Query: ?period=today|7days|30days (default: 7days)
 */
router.get('/analytics/overview', async (req, res) => {
  try {
    const { period = '7days' } = req.query;

    // Calculate since date based on period
    const now = new Date();
    let since;
    if (period === 'today') {
      since = new Date(now);
      since.setHours(0, 0, 0, 0);
    } else if (period === '30days') {
      since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    } else {
      // default: 7days
      since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }
    const sinceISO = since.toISOString();

    // Run all queries in parallel
    const [
      transactionsRes,
      withdrawalsRes,
      allPlayersRes,
      newPlayersRes,
      pillPlaysRes,
      predictionEntriesRes,
      blitzRegsRes,
      gameSessionsRes,
    ] = await Promise.all([
      supabase.from('transactions').select('type, amount').gte('created_at', sinceISO),
      supabase.from('withdrawal_requests').select('status, amount'),
      supabase.from('players').select('id', { count: 'exact', head: true }),
      supabase.from('players').select('id', { count: 'exact', head: true }).gte('created_at', sinceISO),
      supabase.from('pill_plays').select('id', { count: 'exact', head: true }).gte('created_at', sinceISO),
      supabase.from('prediction_participations').select('id', { count: 'exact', head: true }).gte('created_at', sinceISO),
      supabase.from('blitz_registrations').select('id', { count: 'exact', head: true }).gte('registered_at', sinceISO),
      supabase.from('game_sessions').select('player_id', { count: 'exact' }).gte('played_at', sinceISO),
    ]);

    // ── Money metrics ─────────────────────────────────────────────────────
    const transactions = transactionsRes.data || [];

    const totalRevenue = transactions
      .filter((t) => ['prediction_enter', 'pill_play', 'blitz_register', 'entry_fee'].includes(t.type))
      .reduce((sum, t) => sum + Math.abs(t.amount), 0);

    const totalPayouts = transactions
      .filter((t) => ['prediction_win', 'pill_win', 'blitz_prize', 'prize'].includes(t.type))
      .reduce((sum, t) => sum + Math.abs(t.amount), 0);

    const allWithdrawals = withdrawalsRes.data || [];
    const pendingWithdrawalValue = allWithdrawals
      .filter((w) => w.status === 'pending')
      .reduce((sum, w) => sum + (w.amount || 0), 0);

    // ── Player metrics ────────────────────────────────────────────────────
    const totalRegistered = allPlayersRes.count || 0;
    const newThisPeriod = newPlayersRes.count || 0;
    const gameSessions = gameSessionsRes.data || [];
    const activeThisPeriod = new Set(gameSessions.map((s) => s.player_id).filter(Boolean)).size;

    // ── Game metrics ──────────────────────────────────────────────────────
    const pillsPlayed = pillPlaysRes.count || 0;
    const predictionsEntered = predictionEntriesRes.count || 0;
    const blitzRegistrations = blitzRegsRes.count || 0;
    const doorPlays = gameSessionsRes.count || 0;
    const totalPlays = pillsPlayed + predictionsEntered + blitzRegistrations + doorPlays;

    // ── Withdrawal metrics ────────────────────────────────────────────────
    const totalRequested = allWithdrawals.length;
    const totalApproved = allWithdrawals.filter((w) => w.status === 'approved').length;
    const totalPending = allWithdrawals.filter((w) => w.status === 'pending').length;
    const totalRejected = allWithdrawals.filter((w) => w.status === 'rejected').length;

    return res.json({
      success: true,
      data: {
        period,
        money: {
          total_revenue: totalRevenue,
          total_payouts: totalPayouts,
          net_profit: totalRevenue - totalPayouts,
          pending_withdrawal_value: pendingWithdrawalValue,
        },
        players: {
          total_registered: totalRegistered,
          new_this_period: newThisPeriod,
          active_this_period: activeThisPeriod,
        },
        games: {
          pills_played: pillsPlayed,
          predictions_entered: predictionsEntered,
          blitz_registrations: blitzRegistrations,
          total_plays: totalPlays,
        },
        withdrawals: {
          total_requested: totalRequested,
          total_approved: totalApproved,
          total_pending: totalPending,
          total_rejected: totalRejected,
        },
      },
    });
  } catch (err) {
    console.error('Analytics overview error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch analytics overview' });
  }
});

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

// ─── SEED DATA ────────────────────────────────────────────────────────────────

/**
 * POST /api/admin/seed
 * Creates sample games for testing the admin dashboard
 * Creates: 3 pill packs, 3 predictions, 3 blitz tournaments with dummy data
 */
router.post('/seed', async (req, res) => {
  try {
    // Get admin ID from JWT token
    const adminId = req.user?.adminId || req.user?.playerId;
    if (!adminId) {
      return res.status(401).json({ success: false, error: 'Admin authentication required' });
    }

    // Helper function to generate random ID
    const generateId = () => Math.random().toString(36).substring(2, 15);

    // ─── CREATE PILL PACKS ───────────────────────────────────────────────────

    // Pack 1: General Knowledge Pack (active)
    const pack1 = {
      name: 'General Knowledge Pack',
      category: 'General Knowledge',
      status: 'active',
    };

    // Pack 2: Sports Pack (draft)
    const pack2 = {
      name: 'Sports Pack',
      category: 'Sports',
      status: 'draft',
    };

    // Pack 3: Entertainment Pack (active)
    const pack3 = {
      name: 'Entertainment Pack',
      category: 'Entertainment',
      status: 'active',
    };

    const { data: packs, error: packsErr } = await supabase
      .from('pill_packs')
      .insert([pack1, pack2, pack3])
      .select();

    if (packsErr || !packs || packs.length !== 3) {
      console.error('Pill packs creation error:', packsErr);
      return res.status(500).json({ success: false, error: 'Failed to create pill packs' });
    }

    // ─── CREATE PILLS FOR EACH PACK ──────────────────────────────────────────

    const pillsToCreate = [
      // Pack 1: General Knowledge (3 pills)
      {
        pack_id: packs[0].id,
        admin_id: adminId,
        question: 'What is the capital of France?',
        category: 'General Knowledge',
        entry_fee: 200,
        prize: 1000,
        format: 'multiple_choice',
        options: ['London', 'Paris', 'Berlin', 'Madrid'],
        correct_answer: 'Paris',
        timer_seconds: 30,
        color: '#FF4444',
      },
      {
        pack_id: packs[0].id,
        admin_id: adminId,
        question: 'What is the largest planet in our solar system?',
        category: 'General Knowledge',
        entry_fee: 200,
        prize: 1000,
        format: 'multiple_choice',
        options: ['Saturn', 'Mars', 'Jupiter', 'Neptune'],
        correct_answer: 'Jupiter',
        timer_seconds: 30,
        color: '#44FF88',
      },
      {
        pack_id: packs[0].id,
        admin_id: adminId,
        question: 'In what year did the Titanic sink?',
        category: 'General Knowledge',
        entry_fee: 200,
        prize: 1000,
        format: 'multiple_choice',
        options: ['1912', '1915', '1920', '1905'],
        correct_answer: '1912',
        timer_seconds: 30,
        color: '#8844FF',
      },
      // Pack 2: Sports (2 pills)
      {
        pack_id: packs[1].id,
        admin_id: adminId,
        question: 'How many players are on a soccer team?',
        category: 'Sports',
        entry_fee: 500,
        prize: 2000,
        format: 'multiple_choice',
        options: ['9', '10', '11', '12'],
        correct_answer: '11',
        timer_seconds: 30,
        color: '#FFD700',
      },
      {
        pack_id: packs[1].id,
        admin_id: adminId,
        question: 'Which country won the 2022 FIFA World Cup?',
        category: 'Sports',
        entry_fee: 500,
        prize: 2000,
        format: 'multiple_choice',
        options: ['France', 'Brazil', 'Argentina', 'Germany'],
        correct_answer: 'Argentina',
        timer_seconds: 30,
        color: '#FF69B4',
      },
      // Pack 3: Entertainment (4 pills)
      {
        pack_id: packs[2].id,
        admin_id: adminId,
        question: 'Who directed the movie Inception?',
        category: 'Entertainment',
        entry_fee: 100,
        prize: 500,
        format: 'multiple_choice',
        options: ['Martin Scorsese', 'Christopher Nolan', 'Denis Villeneuve', 'Quentin Tarantino'],
        correct_answer: 'Christopher Nolan',
        timer_seconds: 30,
        color: '#00CED1',
      },
      {
        pack_id: packs[2].id,
        admin_id: adminId,
        question: 'Which artist painted the Starry Night?',
        category: 'Entertainment',
        entry_fee: 100,
        prize: 500,
        format: 'multiple_choice',
        options: ['Pablo Picasso', 'Vincent van Gogh', 'Claude Monet', 'Salvador Dali'],
        correct_answer: 'Vincent van Gogh',
        timer_seconds: 30,
        color: '#32CD32',
      },
      {
        pack_id: packs[2].id,
        admin_id: adminId,
        question: 'What is the best-selling video game of all time?',
        category: 'Entertainment',
        entry_fee: 100,
        prize: 500,
        format: 'multiple_choice',
        options: ['Minecraft', 'Tetris', 'Wii Sports', 'Grand Theft Auto V'],
        correct_answer: 'Minecraft',
        timer_seconds: 30,
        color: '#FF8C00',
      },
      {
        pack_id: packs[2].id,
        admin_id: adminId,
        question: 'Which series won the Emmy for Outstanding Drama Series in 2023?',
        category: 'Entertainment',
        entry_fee: 100,
        prize: 500,
        format: 'multiple_choice',
        options: ['Breaking Bad', 'Game of Thrones', 'Succession', 'The Crown'],
        correct_answer: 'Succession',
        timer_seconds: 30,
        color: '#9370DB',
      },
    ];

    const { data: pills, error: pillsErr } = await supabase
      .from('pills')
      .insert(pillsToCreate)
      .select();

    if (pillsErr || !pills) {
      console.error('Pills creation error:', pillsErr);
      return res.status(500).json({ success: false, error: 'Failed to create pills' });
    }

    // ─── CREATE PREDICTIONS ───────────────────────────────────────────────────

    const now = new Date();
    const in2Hours = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const pastCountdown = new Date(now.getTime() - 1 * 60 * 60 * 1000);

    const predictionsToCreate = [
      {
        admin_id: adminId,
        question: 'How many goals will Manchester United score this weekend?',
        category: 'Football',
        entry_fee: 500,
        prize_per_winner: 2000,
        max_participants: 50,
        current_participants: 15,
        countdown_seconds: 7200,
        countdown_end_time: in2Hours.toISOString(),
        status: 'active',
      },
      {
        admin_id: adminId,
        question: 'Will Bitcoin reach $50,000?',
        category: 'Cryptocurrency',
        entry_fee: 1000,
        prize_per_winner: 5000,
        max_participants: 100,
        current_participants: 30,
        countdown_seconds: 3600,
        countdown_end_time: pastCountdown.toISOString(),
        status: 'locked',
      },
      {
        admin_id: adminId,
        question: 'Who will win the next election?',
        category: 'Politics',
        entry_fee: 2000,
        prize_per_winner: 10000,
        max_participants: 200,
        current_participants: 0,
        countdown_seconds: 86400,
        countdown_end_time: in24Hours.toISOString(),
        status: 'draft',
      },
    ];

    const { data: predictions, error: predictionsErr } = await supabase
      .from('predictions')
      .insert(predictionsToCreate)
      .select();

    if (predictionsErr || !predictions || predictions.length !== 3) {
      console.error('Predictions creation error:', predictionsErr);
      return res.status(500).json({ success: false, error: 'Failed to create predictions' });
    }

    // Create dummy prediction participations for first prediction (15 players)
    const predictionParticipations = [];
    for (let i = 0; i < 15; i++) {
      predictionParticipations.push({
        prediction_id: predictions[0].id,
        player_id: null, // Dummy entries, no actual player
        answer: Math.floor(Math.random() * 5).toString(),
        is_correct: false,
        submitted_at: new Date().toISOString(),
      });
    }

    // Create dummy participations for second prediction (30 players)
    for (let i = 0; i < 30; i++) {
      predictionParticipations.push({
        prediction_id: predictions[1].id,
        player_id: null,
        answer: i % 2 === 0 ? 'yes' : 'no',
        is_correct: false,
        submitted_at: pastCountdown.toISOString(),
      });
    }

    if (predictionParticipations.length > 0) {
      const { error: partErr } = await supabase
        .from('prediction_participations')
        .insert(predictionParticipations);

      if (partErr) {
        console.error('Prediction participations error:', partErr);
        // Continue anyway, participations are optional for seed
      }
    }

    // ─── CREATE BLITZ TOURNAMENTS ────────────────────────────────────────────

    const in30Mins = new Date(now.getTime() + 30 * 60 * 1000);
    const in10Mins = new Date(now.getTime() + 10 * 60 * 1000);
    const past30Mins = new Date(now.getTime() - 30 * 60 * 1000);
    const past10Mins = new Date(now.getTime() - 10 * 60 * 1000);

    const tournamentsToCreate = [
      {
        title: 'Speed Quiz Challenge',
        description: 'Answer as many questions as you can in 2 minutes',
        entry_fee: 500,
        question_count: 10,
        time_limit_seconds: 120,
        registration_start: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
        tournament_start: in30Mins.toISOString(),
        tournament_end: new Date(in30Mins.getTime() + 2 * 60 * 60 * 1000).toISOString(),
        status: 'registration',
        total_registered: 25,
        prize_pool: 12500,
        platform_cut_percent: 50,
        created_by: adminId,
      },
      {
        title: 'Football Legends',
        description: 'Test your knowledge on football history and legends',
        entry_fee: 1000,
        question_count: 20,
        time_limit_seconds: 180,
        registration_start: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
        tournament_start: in10Mins.toISOString(),
        tournament_end: new Date(in10Mins.getTime() + 3 * 60 * 60 * 1000).toISOString(),
        status: 'active',
        total_registered: 100,
        prize_pool: 100000,
        platform_cut_percent: 50,
        created_by: adminId,
      },
      {
        title: 'Crypto Quiz Showdown',
        description: 'Master the cryptocurrency questions',
        entry_fee: 1000,
        question_count: 15,
        time_limit_seconds: 150,
        registration_start: new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString(),
        tournament_start: past30Mins.toISOString(),
        tournament_end: past10Mins.toISOString(),
        status: 'completed',
        total_registered: 80,
        prize_pool: 80000,
        platform_cut_percent: 50,
        created_by: adminId,
      },
    ];

    const { data: tournaments, error: tournamentsErr } = await supabase
      .from('blitz_tournaments')
      .insert(tournamentsToCreate)
      .select();

    if (tournamentsErr || !tournaments || tournaments.length !== 3) {
      console.error('Tournaments creation error:', tournamentsErr);
      return res.status(500).json({ success: false, error: 'Failed to create tournaments' });
    }

    // Create questions for each tournament
    const blitzQuestionsToCreate = [];
    const questionSets = [
      [
        { q: 'What is 2+2?', a: '4' },
        { q: 'What is the capital of Nigeria?', a: 'Abuja' },
      ],
      [
        { q: 'How many goals did Messi score in 2023?', a: '42' },
        { q: 'Which club did Ronaldo join in 2023?', a: 'Al Nassr' },
      ],
      [
        { q: 'What year was Bitcoin created?', a: '2009' },
        { q: 'Who created Bitcoin?', a: 'Satoshi Nakamoto' },
      ],
    ];

    for (let tIdx = 0; tIdx < tournaments.length; tIdx++) {
      const qSet = questionSets[tIdx];
      for (let qIdx = 0; qIdx < qSet.length; qIdx++) {
        blitzQuestionsToCreate.push({
          tournament_id: tournaments[tIdx].id,
          question: qSet[qIdx].q,
          format: 'type_answer',
          correct_answer: qSet[qIdx].a,
          order_index: qIdx + 1,
        });
      }
    }

    const { error: blitzQErr } = await supabase
      .from('blitz_questions')
      .insert(blitzQuestionsToCreate);

    if (blitzQErr) {
      console.error('Blitz questions error:', blitzQErr);
      // Continue anyway
    }

    // Create dummy leaderboard data for completed tournament
    const blitzAttemptsToCreate = [];
    for (let i = 0; i < 80; i++) {
      const score = Math.max(0, 2 - Math.floor(Math.random() * 3)); // 0, 1, or 2
      blitzAttemptsToCreate.push({
        tournament_id: tournaments[2].id, // Completed tournament
        player_id: null, // Dummy
        answers: [
          { question_id: '1', answer: Math.random() > 0.5 ? '4' : '5', is_correct: Math.random() > 0.5 },
          { question_id: '2', answer: Math.random() > 0.5 ? 'Abuja' : 'Lagos', is_correct: Math.random() > 0.5 },
        ],
        score,
        total_time_ms: Math.random() * 150000,
        started_at: past30Mins.toISOString(),
        completed_at: past10Mins.toISOString(),
        status: 'completed',
      });
    }

    if (blitzAttemptsToCreate.length > 0) {
      const { error: attErr } = await supabase
        .from('blitz_attempts')
        .insert(blitzAttemptsToCreate);

      if (attErr) {
        console.error('Blitz attempts error:', attErr);
        // Continue anyway
      }
    }

    // Create prize entries for completed tournament
    const blitzPrizesToCreate = [];
    // Top 3 get cash, 4-10 get free tickets
    const prizeDistribution = [
      { position: 1, type: 'cash', amount: 40000 },
      { position: 2, type: 'cash', amount: 24000 },
      { position: 3, type: 'cash', amount: 16000 },
      { position: 4, type: 'free_ticket', amount: 0, ticket: `FT-${generateId()}` },
      { position: 5, type: 'free_ticket', amount: 0, ticket: `FT-${generateId()}` },
      { position: 6, type: 'free_ticket', amount: 0, ticket: `FT-${generateId()}` },
      { position: 7, type: 'free_ticket', amount: 0, ticket: `FT-${generateId()}` },
      { position: 8, type: 'free_ticket', amount: 0, ticket: `FT-${generateId()}` },
      { position: 9, type: 'free_ticket', amount: 0, ticket: `FT-${generateId()}` },
      { position: 10, type: 'free_ticket', amount: 0, ticket: `FT-${generateId()}` },
    ];

    for (const prize of prizeDistribution) {
      blitzPrizesToCreate.push({
        tournament_id: tournaments[2].id,
        player_id: null, // Dummy
        position: prize.position,
        prize_type: prize.type,
        amount: prize.amount,
        ticket_code: prize.ticket || null,
        distributed_at: new Date().toISOString(),
      });
    }

    if (blitzPrizesToCreate.length > 0) {
      const { error: prizeErr } = await supabase
        .from('blitz_prizes')
        .insert(blitzPrizesToCreate);

      if (prizeErr) {
        console.error('Blitz prizes error:', prizeErr);
        // Continue anyway
      }
    }

    return res.status(201).json({
      success: true,
      data: {
        packs_created: 3,
        predictions_created: 3,
        blitz_created: 3,
        message: 'Seed data created successfully',
        details: {
          packs: packs.map((p) => ({ id: p.id, name: p.name, status: p.status })),
          predictions: predictions.map((p) => ({ id: p.id, question: p.question, status: p.status })),
          tournaments: tournaments.map((t) => ({ id: t.id, title: t.title, status: t.status })),
        },
      },
    });
  } catch (err) {
    console.error('Seed data error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create seed data: ' + err.message });
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
