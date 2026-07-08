const express = require('express');
const supabase = require('../db/supabase');
const auth = require('../middleware/auth');

const router = express.Router();

/**
 * Helper: create a notification (used by other routes)
 */
async function createNotification(playerId, type, title, message) {
  if (!playerId) return;
  try {
    await supabase.from('notifications').insert({ player_id: playerId, type, title, message });
  } catch (err) {
    console.error('createNotification error:', err.message);
  }
}

/**
 * Helper: create notifications for multiple players at once
 */
async function createNotifications(rows) {
  if (!rows || rows.length === 0) return;
  try {
    await supabase.from('notifications').insert(rows);
  } catch (err) {
    console.error('createNotifications bulk error:', err.message);
  }
}

/**
 * GET /api/notifications
 * Returns player's notifications, newest first, limit 20
 */
router.get('/', auth, async (req, res) => {
  try {
    const playerId = req.player.id;

    const { data: notifications, error } = await supabase
      .from('notifications')
      .select('id, type, title, message, read, created_at')
      .eq('player_id', playerId)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) return res.status(500).json({ success: false, error: 'Failed to fetch notifications' });

    const unreadCount = (notifications || []).filter((n) => !n.read).length;

    return res.json({
      success: true,
      data: {
        notifications: notifications || [],
        unread_count: unreadCount,
      },
    });
  } catch (err) {
    console.error('Get notifications error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch notifications' });
  }
});

/**
 * PUT /api/notifications/read
 * Mark all notifications as read, or a specific one if body has { id }
 */
router.put('/read', auth, async (req, res) => {
  try {
    const playerId = req.player.id;
    const { id } = req.body;

    let query = supabase
      .from('notifications')
      .update({ read: true })
      .eq('player_id', playerId);

    if (id) query = query.eq('id', id);

    const { error } = await query;

    if (error) return res.status(500).json({ success: false, error: 'Failed to mark notifications as read' });

    return res.json({ success: true, data: { message: id ? 'Notification marked as read' : 'All notifications marked as read' } });
  } catch (err) {
    console.error('Mark read error:', err);
    return res.status(500).json({ success: false, error: 'Failed to mark notifications as read' });
  }
});

module.exports = router;
module.exports.createNotification = createNotification;
module.exports.createNotifications = createNotifications;
