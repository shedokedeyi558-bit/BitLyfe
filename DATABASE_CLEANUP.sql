-- BitLyfe Database Cleanup Script (CORRECTED)
-- Preserves schema and admin account, clears all test data

-- TRUNCATE TABLES IN DEPENDENCY ORDER (respect foreign keys)
TRUNCATE TABLE public.challenge_participations CASCADE;
TRUNCATE TABLE public.blitz_attempts CASCADE;
TRUNCATE TABLE public.blitz_registrations CASCADE;
TRUNCATE TABLE public.blitz_questions CASCADE;
TRUNCATE TABLE public.blitz_prizes CASCADE;
TRUNCATE TABLE public.pill_plays CASCADE;
TRUNCATE TABLE public.pills CASCADE;
TRUNCATE TABLE public.pill_packs CASCADE;
TRUNCATE TABLE public.prediction_participations CASCADE;
TRUNCATE TABLE public.predictions CASCADE;
TRUNCATE TABLE public.blitz_tournaments CASCADE;
TRUNCATE TABLE public.challenges CASCADE;
TRUNCATE TABLE public.game_sessions CASCADE;
TRUNCATE TABLE public.questions CASCADE;
TRUNCATE TABLE public.transactions CASCADE;
TRUNCATE TABLE public.withdrawal_requests CASCADE;

-- DELETE ALL PLAYERS EXCEPT ADMIN (no TRUNCATE WHERE clause)
DELETE FROM public.players WHERE email != 'shedokedeyi558@gmail.com';

-- CLEAR LOGS
TRUNCATE TABLE public.webhook_logs CASCADE;
TRUNCATE TABLE public.error_logs CASCADE;

-- VERIFY ADMIN STILL EXISTS
SELECT id, email FROM public.admins WHERE email = 'shedokedeyi558@gmail.com';

-- SHOW FINAL STATUS
SELECT 
  'admins' as table_name, COUNT(*) as row_count FROM public.admins
UNION ALL SELECT 'players', COUNT(*) FROM public.players
UNION ALL SELECT 'pills', COUNT(*) FROM public.pills
UNION ALL SELECT 'pill_packs', COUNT(*) FROM public.pill_packs
UNION ALL SELECT 'predictions', COUNT(*) FROM public.predictions
UNION ALL SELECT 'blitz_tournaments', COUNT(*) FROM public.blitz_tournaments
UNION ALL SELECT 'challenges', COUNT(*) FROM public.challenges
UNION ALL SELECT 'game_sessions', COUNT(*) FROM public.game_sessions
UNION ALL SELECT 'transactions', COUNT(*) FROM public.transactions;
