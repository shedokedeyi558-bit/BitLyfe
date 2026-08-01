-- Atomic pack claiming RPC for Specials/VIP packs with max_entries cap.
-- Same shape as claim_pill_for_opening() — UPDATE ... WHERE condition RETURNING row count.
--
-- claim_pack_for_player(p_pack_id):
--   Atomically increments current_entries ONLY when current_entries < max_entries.
--   Returns:
--     claimed = true  → slot was available and is now taken; caller should proceed to billing
--     claimed = false → cap already reached; caller must reject WITHOUT charging player
--
-- This must be called BEFORE deductEntryFee(). If it returns false, return 410 immediately.
-- Never charge a player, then refund — reject upfront.
--
-- Idempotency note: if billing or attempt insert fails after a successful claim,
-- call release_pack_claim(p_pack_id) to decrement current_entries back.

CREATE OR REPLACE FUNCTION claim_pack_for_player(p_pack_id UUID)
RETURNS TABLE (claimed BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_rows INT;
BEGIN
  -- Atomically increment current_entries only when still under the cap.
  -- If max_entries IS NULL (no cap), always succeeds.
  UPDATE pill_packs
  SET current_entries = COALESCE(current_entries, 0) + 1
  WHERE id = p_pack_id
    AND (
      max_entries IS NULL                          -- no cap — always open
      OR COALESCE(current_entries, 0) < max_entries  -- under cap — slot available
    );

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  RETURN QUERY SELECT (v_rows > 0);
END;
$$;

-- Rollback function — called when billing or attempt insert fails after a successful claim
CREATE OR REPLACE FUNCTION release_pack_claim(p_pack_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE pill_packs
  SET current_entries = GREATEST(0, COALESCE(current_entries, 1) - 1)
  WHERE id = p_pack_id;
END;
$$;

GRANT EXECUTE ON FUNCTION claim_pack_for_player(UUID) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION release_pack_claim(UUID) TO anon, authenticated, service_role;

-- Verify
SELECT proname FROM pg_proc WHERE proname IN ('claim_pack_for_player', 'release_pack_claim');
