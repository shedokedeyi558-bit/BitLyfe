const jwt = require('jsonwebtoken');
const supabase = require('../db/supabase');

const adminAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Admin authorization token required' });
    }

    const token = authHeader.split(' ')[1];

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      const code = err.name === 'TokenExpiredError' ? 'SESSION_EXPIRED' : 'INVALID_TOKEN';
      return res.status(401).json({ success: false, code, error: code === 'SESSION_EXPIRED' ? 'Admin session expired — please log in again' : 'Invalid or expired admin token' });
    }

    // Support both old format (adminId) and new format (playerId with is_admin)
    const adminId = decoded.adminId || (decoded.is_admin ? decoded.playerId : null);

    if (!adminId) {
      return res.status(403).json({ success: false, error: 'Access denied: not an admin token' });
    }

    // For new unified system, use player model; for legacy, use admin model
    let admin;

    if (decoded.is_admin) {
      // New unified system - fetch from players
      const { data: player } = await supabase
        .from('players')
        .select('id, email, is_admin')
        .eq('id', adminId)
        .eq('is_admin', true)
        .single();

      admin = player;
    } else {
      // Legacy system - fetch from admins
      const { data: legacyAdmin } = await supabase
        .from('admins')
        .select('id, email')
        .eq('id', adminId)
        .single();

      admin = legacyAdmin;
    }

    if (!admin) {
      return res.status(401).json({ success: false, error: 'Admin not found' });
    }

    req.admin = admin;
    next();
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Admin authentication error' });
  }
};

module.exports = adminAuth;
