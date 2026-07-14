const jwt = require('jsonwebtoken');
const supabase = require('../db/supabase');

const auth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Authorization token required' });
    }

    const token = authHeader.split(' ')[1];

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      const code = err.name === 'TokenExpiredError' ? 'SESSION_EXPIRED' : 'INVALID_TOKEN';
      return res.status(401).json({ success: false, code, error: code === 'SESSION_EXPIRED' ? 'Session expired — please log in again' : 'Invalid token' });
    }

    // Fetch player from DB to ensure they're still active and token_version matches
    const { data: player, error } = await supabase
      .from('players')
      .select('id, phone, name, balance, bonus_balance, status, token_version')
      .eq('id', decoded.playerId)
      .single();

    if (error || !player) {
      return res.status(401).json({ success: false, error: 'Player not found' });
    }

    if (player.status === 'banned') {
      return res.status(403).json({ success: false, error: 'Your account has been banned' });
    }

    // Token version check — fails if password was reset or logout-all was called
    const tokenVersion = decoded.token_version ?? 0;
    const storedVersion = player.token_version ?? 0;
    if (tokenVersion !== storedVersion) {
      return res.status(401).json({
        success: false,
        code: 'SESSION_INVALIDATED',
        error: 'Session has been invalidated. Please log in again.',
      });
    }

    req.player = player;
    next();
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Authentication error' });
  }
};

module.exports = auth;
