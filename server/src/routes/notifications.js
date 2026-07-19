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
 * Returns player's notifications, newest first, limit 20.
 * Query: ?unread_only=true — exclude notifications already marked read.
 *        ?limit=N — override default limit of 20.
 */
router.get('/', auth, async (req, res) => {
  try {
    const playerId = req.player.id;
    const unreadOnly = req.query.unread_only === 'true';
    const limit = Math.min(Number(req.query.limit) || 20, 100);

    let query = supabase
      .from('notifications')
      .select('id, type, title, message, read, created_at')
      .eq('player_id', playerId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (unreadOnly) query = query.eq('read', false);

    const { data: notifications, error } = await query;

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
 * PATCH /api/notifications/:id/read
 * Mark a single notification as read (dismiss it).
 * Only the owning player can dismiss their own notifications.
 * Does NOT touch balance, transactions, or any other data.
 */
router.patch('/:id/read', auth, async (req, res) => {
  try {
    const playerId = req.player.id;
    const { id } = req.params;

    const { data, error } = await supabase
      .from('notifications')
      .update({ read: true })
      .eq('id', id)
      .eq('player_id', playerId)  // ownership guard — can't dismiss another player's notification
      .select('id, read')
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, error: 'Failed to dismiss notification' });
    if (!data) return res.status(404).json({ success: false, error: 'Notification not found' });

    return res.json({ success: true, data: { id: data.id, read: data.read } });
  } catch (err) {
    console.error('Dismiss notification error:', err);
    return res.status(500).json({ success: false, error: 'Failed to dismiss notification' });
  }
});

/**
 * PUT /api/notifications/read
 * Mark all notifications as read, or a specific one if body has { id }.
 * Kept for backward compatibility — prefer PATCH /:id/read for single dismissals.
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

/**
 * DELETE /api/notifications/clear-all
 * Permanently delete all of the authenticated player's notifications.
 * This is a display-only action — no balance, transaction, or game data is affected.
 * After this call, GET /api/notifications returns an empty list and unread_count: 0.
 */
router.delete('/clear-all', auth, async (req, res) => {
  try {
    const playerId = req.player.id;

    const { error } = await supabase
      .from('notifications')
      .delete()
      .eq('player_id', playerId);

    if (error) return res.status(500).json({ success: false, error: 'Failed to clear notifications' });

    return res.json({
      success: true,
      data: { message: 'All notifications cleared' },
    });
  } catch (err) {
    console.error('Clear all notifications error:', err);
    return res.status(500).json({ success: false, error: 'Failed to clear notifications' });
  }
});

module.exports = router;
module.exports.createNotification = createNotification;
module.exports.createNotifications = createNotifications;
