/**
 * adminSpecialsBank.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Admin tooling for filling Specials pack question banks quickly.
 * Specials packs only — standard Pills packs are unaffected.
 *
 * Routes mounted at /api/admin/specials-bank:
 *
 *   Pack bank CRUD (thin wrappers — core CRUD lives in adminPills.js):
 *     POST   /packs/:packId/import          bulk import CSV or JSON into a pack bank
 *     POST   /packs/:packId/clone-from/:sourcePackId  clone another pack's bank
 *
 *   Draft Question Library:
 *     GET    /library                       list (paginated, filterable)
 *     POST   /library                       add one question
 *     PATCH  /library/:id                  edit
 *     DELETE /library/:id                  soft-delete
 *     POST   /library/import               bulk import CSV or JSON into library
 *     POST   /library/copy-to-pack         copy selected drafts → pack as new rows
 */

const express = require('express');
const multer  = require('multer');
const { parse } = require('csv-parse/sync');
const supabase  = require('../db/supabase');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.use(adminAuth);

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/** Validate and normalise a single raw question row from CSV or JSON import. */
function normaliseRow(raw, index) {
  const question      = (raw.question || raw.text || '').trim();
  const correct_answer = (raw.correct_answer || raw.answer || '').trim();
  const format        = (raw.format || 'multiple_choice').trim().toLowerCase();

  if (!question)       return { error: `Row ${index + 1}: question/text is required` };
  if (!correct_answer) return { error: `Row ${index + 1}: correct_answer is required` };
  if (!['multiple_choice', 'type_answer'].includes(format)) {
    return { error: `Row ${index + 1}: format must be multiple_choice or type_answer` };
  }

  let options = raw.options || null;
  if (typeof options === 'string') {
    try { options = JSON.parse(options); } catch { options = null; }
  }

  return {
    question,
    format,
    options:        options || null,
    correct_answer,
    case_sensitive: raw.case_sensitive === true || raw.case_sensitive === 'true',
    timer_seconds:  raw.timer_seconds  ? Number(raw.timer_seconds)  : (raw.timer ? Number(raw.timer) : 30),
    color:          raw.color || '#8B5CF6',
  };
}

/** Parse an uploaded file (multipart) or a JSON body array into raw rows. */
function parseInput(file, bodyRows) {
  if (file) {
    const content = file.buffer.toString('utf-8');
    const isJson  = file.mimetype === 'application/json' || file.originalname?.endsWith('.json');
    if (isJson) return JSON.parse(content);
    return parse(content, { columns: true, skip_empty_lines: true, trim: true });
  }
  if (Array.isArray(bodyRows)) return bodyRows;
  if (typeof bodyRows === 'string') return JSON.parse(bodyRows);
  return [];
}

/** Confirm a pack exists and is a Specials pack. Returns { pack } or throws. */
async function requireSpecialsPack(packId) {
  const { data, error } = await supabase
    .from('pill_packs')
    .select('id, name, pack_type, is_vip, entry_fee, prize')
    .eq('id', packId)
    .single();
  if (error || !data) throw Object.assign(new Error('Pack not found'), { status: 404 });
  const isSpecial = data.pack_type === 'special' || data.is_vip;
  if (!isSpecial) throw Object.assign(
    new Error('This endpoint is for Specials packs only. Standard Pills packs are unaffected.'),
    { status: 400 }
  );
  return data;
}

// ─── PACK BANK: BULK IMPORT ───────────────────────────────────────────────────

/**
 * POST /api/admin/specials-bank/packs/:packId/import
 * Bulk-insert questions into a Specials pack bank from CSV or JSON.
 *
 * Multipart (file upload):
 *   Field "file": CSV or JSON file. JSON must be an array of objects.
 *   CSV columns: question, format, options (JSON string), correct_answer,
 *                case_sensitive, timer_seconds, color
 *
 * JSON body (no file):
 *   { "questions": [ { question, format, options, correct_answer, ... }, ... ] }
 *
 * All rows are validated first — if any row fails validation the entire
 * import is rejected (no partial inserts).
 *
 * Response: { success, data: { imported: N, questions: [...] } }
 */
router.post('/packs/:packId/import', upload.single('file'), async (req, res) => {
  try {
    const pack = await requireSpecialsPack(req.params.packId).catch((err) =>
      res.status(err.status || 500).json({ success: false, error: err.message })
    );
    if (!pack) return;

    const rawRows = parseInput(req.file, req.body.questions);
    if (!rawRows.length) {
      return res.status(400).json({ success: false, error: 'No questions provided' });
    }

    // Validate all rows before inserting anything
    const normalised = [];
    for (let i = 0; i < rawRows.length; i++) {
      const result = normaliseRow(rawRows[i], i);
      if (result.error) return res.status(400).json({ success: false, error: result.error });
      normalised.push(result);
    }

    const resolvedFee   = pack.entry_fee   !== null ? Number(pack.entry_fee)  : 0;
    const resolvedPrize = pack.prize        !== null ? Number(pack.prize)      : 0;

    const toInsert = normalised.map((q) => ({
      admin_id:       req.admin?.id || null,
      pack_id:        pack.id,
      question:       q.question,
      format:         q.format,
      options:        q.options,
      correct_answer: q.correct_answer,
      case_sensitive: q.case_sensitive,
      timer_seconds:  q.timer_seconds,
      color:          q.color,
      entry_fee:      resolvedFee,
      prize:          resolvedPrize,
      status:         'available',
    }));

    const { data, error } = await supabase.from('pills').insert(toInsert).select();
    if (error) return res.status(500).json({ success: false, error: 'Bulk import failed: ' + error.message });

    return res.status(201).json({ success: true, data: { imported: data.length, questions: data } });
  } catch (err) {
    console.error('Pack bank import error:', err);
    return res.status(500).json({ success: false, error: 'Import failed' });
  }
});

// ─── PACK BANK: CLONE ─────────────────────────────────────────────────────────

/**
 * POST /api/admin/specials-bank/packs/:packId/clone-from/:sourcePackId
 * Clone questions from a source Specials pack bank into the target pack.
 * Creates fully independent rows — editing clones never touches originals.
 *
 * Body (optional):
 *   { "question_ids": ["uuid1", "uuid2", ...] }
 *   Omit or send empty array to clone the entire source bank.
 *
 * Response: { success, data: { cloned: N, questions: [...] } }
 */
router.post('/packs/:packId/clone-from/:sourcePackId', async (req, res) => {
  try {
    const { packId, sourcePackId } = req.params;
    const { question_ids } = req.body;

    if (packId === sourcePackId) {
      return res.status(400).json({ success: false, error: 'Source and target pack must be different' });
    }

    // Confirm both packs are Specials
    const [targetPack, sourcePack] = await Promise.all([
      requireSpecialsPack(packId),
      requireSpecialsPack(sourcePackId),
    ]).catch((err) => {
      res.status(err.status || 500).json({ success: false, error: err.message });
      return null;
    });
    if (!targetPack) return;

    // Fetch source questions (non-deleted, available or expired — clone all states)
    let query = supabase
      .from('pills')
      .select('question, format, options, correct_answer, case_sensitive, timer_seconds, color')
      .eq('pack_id', sourcePackId)
      .is('deleted_at', null);

    if (Array.isArray(question_ids) && question_ids.length > 0) {
      query = query.in('id', question_ids);
    }

    const { data: sourceRows, error: fetchErr } = await query;
    if (fetchErr) return res.status(500).json({ success: false, error: 'Failed to fetch source questions' });
    if (!sourceRows || sourceRows.length === 0) {
      return res.status(404).json({ success: false, error: 'No questions found in source pack' });
    }

    const resolvedFee   = targetPack.entry_fee !== null ? Number(targetPack.entry_fee)  : 0;
    const resolvedPrize = targetPack.prize      !== null ? Number(targetPack.prize)      : 0;

    const toInsert = sourceRows.map((q) => ({
      admin_id:       req.admin?.id || null,
      pack_id:        packId,
      question:       q.question,
      format:         q.format,
      options:        q.options,
      correct_answer: q.correct_answer,
      case_sensitive: q.case_sensitive,
      timer_seconds:  q.timer_seconds,
      color:          q.color,
      entry_fee:      resolvedFee,
      prize:          resolvedPrize,
      status:         'available',
      // stats reset to zero — new independent rows
      times_answered: 0,
      times_correct:  0,
    }));

    const { data, error } = await supabase.from('pills').insert(toInsert).select();
    if (error) return res.status(500).json({ success: false, error: 'Clone failed: ' + error.message });

    return res.status(201).json({
      success: true,
      data: {
        cloned: data.length,
        source_pack_id: sourcePackId,
        target_pack_id: packId,
        questions: data,
      },
    });
  } catch (err) {
    console.error('Clone pack bank error:', err);
    return res.status(500).json({ success: false, error: 'Clone failed' });
  }
});

// ─── DRAFT QUESTION LIBRARY: CRUD ────────────────────────────────────────────

/**
 * GET /api/admin/specials-bank/library
 * List non-deleted draft library questions (paginated).
 * Query: ?page=1&limit=20&label=X&format=X&search=X
 */
router.get('/library', async (req, res) => {
  try {
    const { page = 1, limit = 20, label, format, search } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let query = supabase
      .from('draft_question_library')
      .select('id, question, format, options, correct_answer, case_sensitive, timer_seconds, color, label, note, created_at, updated_at', { count: 'exact' })
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (label)  query = query.eq('label', label);
    if (format) query = query.eq('format', format);
    if (search) query = query.ilike('question', `%${search}%`);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ success: false, error: 'Failed to fetch library' });

    return res.json({ success: true, data: { questions: data, total: count, page: Number(page), limit: Number(limit) } });
  } catch (err) {
    console.error('Library list error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch library' });
  }
});

/**
 * POST /api/admin/specials-bank/library
 * Add one question to the draft library.
 * Body: { question, format, options?, correct_answer, case_sensitive?, timer_seconds?, color?, label?, note? }
 */
router.post('/library', async (req, res) => {
  try {
    const { question, format, options, correct_answer, case_sensitive, timer_seconds, color, label, note } = req.body;

    if (!question || !correct_answer) {
      return res.status(400).json({ success: false, error: 'question and correct_answer are required' });
    }
    const fmt = (format || 'multiple_choice').toLowerCase();
    if (!['multiple_choice', 'type_answer'].includes(fmt)) {
      return res.status(400).json({ success: false, error: 'format must be multiple_choice or type_answer' });
    }

    const { data, error } = await supabase
      .from('draft_question_library')
      .insert({
        admin_id:       req.admin?.id || null,
        question:       question.trim(),
        format:         fmt,
        options:        options || null,
        correct_answer: correct_answer.trim(),
        case_sensitive: case_sensitive ?? false,
        timer_seconds:  timer_seconds  ? Number(timer_seconds) : 30,
        color:          color || '#8B5CF6',
        label:          label || null,
        note:           note  || null,
      })
      .select()
      .single();

    if (error) return res.status(500).json({ success: false, error: 'Failed to create library question' });
    return res.status(201).json({ success: true, data: { question: data } });
  } catch (err) {
    console.error('Library create error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create library question' });
  }
});

/**
 * PATCH /api/admin/specials-bank/library/:id
 * Edit a draft library question. Blocked if already soft-deleted.
 * Body: { question?, format?, options?, correct_answer?, case_sensitive?,
 *         timer_seconds?, color?, label?, note? }
 */
router.patch('/library/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { question, format, options, correct_answer, case_sensitive,
            timer_seconds, color, label, note } = req.body;

    const { data: existing, error: fetchErr } = await supabase
      .from('draft_question_library')
      .select('id, deleted_at')
      .eq('id', id)
      .single();

    if (fetchErr || !existing) return res.status(404).json({ success: false, error: 'Library question not found' });
    if (existing.deleted_at)   return res.status(409).json({ success: false, error: 'Cannot edit a deleted library question' });

    const updates = { updated_at: new Date().toISOString() };
    if (question       !== undefined) updates.question       = question.trim();
    if (correct_answer !== undefined) updates.correct_answer = correct_answer.trim();
    if (options        !== undefined) updates.options        = options;
    if (case_sensitive !== undefined) updates.case_sensitive = case_sensitive;
    if (timer_seconds  !== undefined) updates.timer_seconds  = Number(timer_seconds);
    if (color          !== undefined) updates.color          = color;
    if (label          !== undefined) updates.label          = label;
    if (note           !== undefined) updates.note           = note;
    if (format !== undefined) {
      const fmt = format.toLowerCase();
      if (!['multiple_choice', 'type_answer'].includes(fmt)) {
        return res.status(400).json({ success: false, error: 'format must be multiple_choice or type_answer' });
      }
      updates.format = fmt;
    }

    if (Object.keys(updates).length === 1) { // only updated_at
      return res.status(400).json({ success: false, error: 'No valid fields to update' });
    }

    const { data, error } = await supabase
      .from('draft_question_library')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error || !data) return res.status(500).json({ success: false, error: 'Failed to update library question' });
    return res.json({ success: true, data: { question: data } });
  } catch (err) {
    console.error('Library patch error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update library question' });
  }
});

/**
 * DELETE /api/admin/specials-bank/library/:id
 * Soft-delete a draft library question (stamps deleted_at).
 * Originals that have been copied to packs are unaffected — those are
 * independent rows in the pills table.
 */
router.delete('/library/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: existing, error: fetchErr } = await supabase
      .from('draft_question_library')
      .select('id, deleted_at')
      .eq('id', id)
      .single();

    if (fetchErr || !existing) return res.status(404).json({ success: false, error: 'Library question not found' });
    if (existing.deleted_at)   return res.status(409).json({ success: false, error: 'Already deleted' });

    const { error } = await supabase
      .from('draft_question_library')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id);

    if (error) return res.status(500).json({ success: false, error: 'Failed to delete library question' });
    return res.json({ success: true, data: { message: 'Library question soft-deleted' } });
  } catch (err) {
    console.error('Library delete error:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete library question' });
  }
});

// ─── DRAFT LIBRARY: BULK IMPORT ──────────────────────────────────────────────

/**
 * POST /api/admin/specials-bank/library/import
 * Bulk-import questions into the draft library from CSV or JSON.
 *
 * Multipart:  field "file" — CSV or JSON file
 * JSON body:  { "questions": [...] }
 *
 * CSV/JSON columns: question, format, options (JSON string), correct_answer,
 *                   case_sensitive, timer_seconds, color, label, note
 *
 * All rows validated before any insert. Response includes inserted rows.
 */
router.post('/library/import', upload.single('file'), async (req, res) => {
  try {
    const rawRows = parseInput(req.file, req.body.questions);
    if (!rawRows.length) {
      return res.status(400).json({ success: false, error: 'No questions provided' });
    }

    const normalised = [];
    for (let i = 0; i < rawRows.length; i++) {
      const result = normaliseRow(rawRows[i], i);
      if (result.error) return res.status(400).json({ success: false, error: result.error });
      normalised.push(result);
    }

    const toInsert = normalised.map((q) => ({
      admin_id:       req.admin?.id || null,
      question:       q.question,
      format:         q.format,
      options:        q.options,
      correct_answer: q.correct_answer,
      case_sensitive: q.case_sensitive,
      timer_seconds:  q.timer_seconds,
      color:          q.color,
      label:          null,
      note:           null,
    }));

    const { data, error } = await supabase.from('draft_question_library').insert(toInsert).select();
    if (error) return res.status(500).json({ success: false, error: 'Bulk import failed: ' + error.message });

    return res.status(201).json({ success: true, data: { imported: data.length, questions: data } });
  } catch (err) {
    console.error('Library import error:', err);
    return res.status(500).json({ success: false, error: 'Import failed' });
  }
});

// ─── DRAFT LIBRARY: COPY TO PACK ─────────────────────────────────────────────

/**
 * POST /api/admin/specials-bank/library/copy-to-pack
 * Copy selected draft library questions into a Specials pack bank as
 * fully independent rows. Library originals are never modified or consumed —
 * the same drafts can be copied to multiple packs.
 *
 * Body: {
 *   question_ids: ["uuid1", "uuid2", ...],   // required — draft IDs to copy
 *   pack_id: "uuid"                           // required — target pack
 * }
 *
 * Response: { success, data: { copied: N, pack_id, questions: [...] } }
 */
router.post('/library/copy-to-pack', async (req, res) => {
  try {
    const { question_ids, pack_id } = req.body;

    if (!pack_id) {
      return res.status(400).json({ success: false, error: 'pack_id is required' });
    }
    if (!Array.isArray(question_ids) || question_ids.length === 0) {
      return res.status(400).json({ success: false, error: 'question_ids must be a non-empty array' });
    }

    // Confirm target is a Specials pack
    const pack = await requireSpecialsPack(pack_id).catch((err) => {
      res.status(err.status || 500).json({ success: false, error: err.message });
      return null;
    });
    if (!pack) return;

    // Fetch the requested draft questions (non-deleted only)
    // Use parallel .eq() queries — .in('id', uuidArray) silently returns empty for UUID PKs
    const draftResults = await Promise.all(
      question_ids.map((qid) =>
        supabase
          .from('draft_question_library')
          .select('question, format, options, correct_answer, case_sensitive, timer_seconds, color')
          .eq('id', qid)
          .is('deleted_at', null)
          .maybeSingle()
          .then(({ data }) => data)
      )
    );
    const drafts = draftResults.filter(Boolean);

    if (drafts.length === 0) {
      return res.status(404).json({ success: false, error: 'No matching non-deleted library questions found' });
    }

    const resolvedFee   = pack.entry_fee !== null ? Number(pack.entry_fee)  : 0;
    const resolvedPrize = pack.prize      !== null ? Number(pack.prize)      : 0;

    const toInsert = drafts.map((q) => ({
      admin_id:       req.admin?.id || null,
      pack_id:        pack_id,
      question:       q.question,
      format:         q.format,
      options:        q.options,
      correct_answer: q.correct_answer,
      case_sensitive: q.case_sensitive,
      timer_seconds:  q.timer_seconds,
      color:          q.color,
      entry_fee:      resolvedFee,
      prize:          resolvedPrize,
      status:         'available',
      times_answered: 0,
      times_correct:  0,
    }));

    const { data, error } = await supabase.from('pills').insert(toInsert).select();
    if (error) return res.status(500).json({ success: false, error: 'Copy failed: ' + error.message });

    return res.status(201).json({
      success: true,
      data: {
        copied: data.length,
        pack_id,
        questions: data,
      },
    });
  } catch (err) {
    console.error('Copy to pack error:', err);
    return res.status(500).json({ success: false, error: 'Copy failed' });
  }
});

module.exports = router;
