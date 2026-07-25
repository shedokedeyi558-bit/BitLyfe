-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Create admin_create_pill_pack stored procedure
-- ─────────────────────────────────────────────────────────────────────────────
--
-- PURPOSE:
--   PostgREST (Supabase REST API) uses a schema cache that may be stale after
--   new columns are added via ALTER TABLE. Until the cache is refreshed, any
--   direct insert/select that references new columns (max_entries, current_entries,
--   quiz_expires_at, target_bank_size, etc.) returns PGRST204.
--
--   A stored procedure call (supabase.rpc) executes as raw SQL, completely
--   bypassing PostgREST column validation. This is the cleanest workaround.
--
-- USAGE:
--   After running this migration, the Node.js backend can call:
--   supabase.rpc('admin_create_pill_pack', { p_name: '...', ... })
--
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION admin_create_pill_pack(
  p_name               TEXT,
  p_category           TEXT    DEFAULT 'General',
  p_status             TEXT    DEFAULT 'draft',
  p_entry_fee          NUMERIC DEFAULT NULL,
  p_prize              NUMERIC DEFAULT NULL,
  p_is_vip             BOOLEAN DEFAULT FALSE,
  p_pack_type          TEXT    DEFAULT 'standard',
  p_question_count     INTEGER DEFAULT NULL,
  p_total_time_seconds INTEGER DEFAULT NULL,
  p_required_correct   INTEGER DEFAULT NULL,
  p_entry_window_end   TIMESTAMPTZ DEFAULT NULL,
  p_quiz_expires_at    TIMESTAMPTZ DEFAULT NULL,
  p_target_bank_size   INTEGER DEFAULT NULL,
  p_max_entries        INTEGER DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_id UUID;
  v_result JSON;
BEGIN
  INSERT INTO pill_packs (
    name,
    category,
    status,
    entry_fee,
    prize,
    is_vip,
    pack_type,
    question_count,
    total_time_seconds,
    required_correct,
    entry_window_end,
    quiz_expires_at,
    target_bank_size,
    max_entries,
    current_entries
  ) VALUES (
    p_name,
    p_category,
    p_status,
    p_entry_fee,
    p_prize,
    p_is_vip,
    p_pack_type,
    p_question_count,
    p_total_time_seconds,
    p_required_correct,
    p_entry_window_end,
    p_quiz_expires_at,
    p_target_bank_size,
    p_max_entries,
    0
  )
  RETURNING id INTO v_id;

  SELECT row_to_json(t) INTO v_result
  FROM (
    SELECT
      id, name, category, status,
      entry_fee, prize, is_vip, pack_type,
      question_count, total_time_seconds, required_correct,
      entry_window_end, quiz_expires_at,
      target_bank_size, max_entries, current_entries,
      is_featured, created_at
    FROM pill_packs
    WHERE id = v_id
  ) t;

  RETURN v_result;
END;
$$;

-- Grant execute permission to the anon and authenticated roles
GRANT EXECUTE ON FUNCTION admin_create_pill_pack TO anon, authenticated, service_role;

-- Verify the function was created
SELECT proname, prosecdef FROM pg_proc WHERE proname = 'admin_create_pill_pack';

-- ─────────────────────────────────────────────────────────────────────────────
-- Stored procedure: admin_update_pill_pack
-- ─────────────────────────────────────────────────────────────────────────────
-- Takes the update fields as JSONB so only fields present in the object
-- are updated. NULL values in the JSONB explicitly clear fields.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION admin_update_pill_pack(
  p_id      UUID,
  p_updates JSONB
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_result JSON;
BEGIN
  UPDATE pill_packs SET
    name               = CASE WHEN p_updates ? 'name'               THEN (p_updates->>'name')               ELSE name               END,
    category           = CASE WHEN p_updates ? 'category'           THEN (p_updates->>'category')           ELSE category           END,
    status             = CASE WHEN p_updates ? 'status'             THEN (p_updates->>'status')             ELSE status             END,
    is_vip             = CASE WHEN p_updates ? 'is_vip'             THEN (p_updates->>'is_vip')::BOOLEAN    ELSE is_vip             END,
    pack_type          = CASE WHEN p_updates ? 'pack_type'          THEN (p_updates->>'pack_type')          ELSE pack_type          END,
    is_featured        = CASE WHEN p_updates ? 'is_featured'        THEN (p_updates->>'is_featured')::BOOLEAN ELSE is_featured       END,
    entry_fee          = CASE WHEN p_updates ? 'entry_fee'          THEN (p_updates->>'entry_fee')::NUMERIC  ELSE entry_fee         END,
    prize              = CASE WHEN p_updates ? 'prize'              THEN (p_updates->>'prize')::NUMERIC      ELSE prize             END,
    question_count     = CASE WHEN p_updates ? 'question_count'     THEN (p_updates->>'question_count')::INTEGER ELSE question_count END,
    total_time_seconds = CASE WHEN p_updates ? 'total_time_seconds' THEN (p_updates->>'total_time_seconds')::INTEGER ELSE total_time_seconds END,
    required_correct   = CASE WHEN p_updates ? 'required_correct'   THEN (p_updates->>'required_correct')::INTEGER ELSE required_correct END,
    entry_window_end   = CASE WHEN p_updates ? 'entry_window_end'   THEN (p_updates->>'entry_window_end')::TIMESTAMPTZ ELSE entry_window_end END,
    quiz_expires_at    = CASE WHEN p_updates ? 'quiz_expires_at'    THEN (p_updates->>'quiz_expires_at')::TIMESTAMPTZ ELSE quiz_expires_at END,
    target_bank_size   = CASE WHEN p_updates ? 'target_bank_size'   THEN (p_updates->>'target_bank_size')::INTEGER ELSE target_bank_size END,
    max_entries        = CASE WHEN p_updates ? 'max_entries'        THEN (p_updates->>'max_entries')::INTEGER ELSE max_entries       END
  WHERE id = p_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT row_to_json(t) INTO v_result
  FROM (
    SELECT
      id, name, category, status,
      entry_fee, prize, is_vip, pack_type,
      question_count, total_time_seconds, required_correct,
      entry_window_end, quiz_expires_at,
      target_bank_size, max_entries, current_entries,
      is_featured, created_at
    FROM pill_packs
    WHERE id = p_id
  ) t;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_update_pill_pack TO anon, authenticated, service_role;

-- Verify
SELECT proname FROM pg_proc WHERE proname IN ('admin_create_pill_pack', 'admin_update_pill_pack');
