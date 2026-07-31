TASK 8: BLITZ TOURNAMENT ADMIN ENDPOINTS
=========================================

COMPLETED IMPLEMENTATION
========================

Two new admin endpoints for Blitz tournament management:

1. GET /api/admin/blitz/:id — Tournament detail with full config
2. PATCH /api/admin/blitz/:id — Edit tournament with registration lock


ENDPOINT 1: GET /api/admin/blitz/:id
====================================

Description:
  Returns full tournament configuration + current registered player count.
  All fields needed for the admin dashboard.

URL:
  GET https://bitlyf-iiek.onrender.com/api/admin/blitz/:tournamentId

Auth:
  Required: adminAuth middleware (Bearer token)

Response (200 OK):
{
  "success": true,
  "data": {
    "tournament": {
      "id": "uuid",
      "title": "Weekly Blitz #1",
      "description": "Fast-paced tournament",
      "status": "draft",
      "entry_fee": 1000,
      "question_count": 10,
      "time_limit_seconds": 300,
      "per_question_time_seconds": 8,
      "registration_start": "2026-07-31T10:00:00Z",
      "tournament_start": "2026-07-31T11:00:00Z",
      "tournament_end": "2026-07-31T14:00:00Z",
      "max_participants": 50,
      "min_participants": 1,
      "prize_pool": 50000,
      "cash_winner_count": 1,
      "payout_distribution": [100],
      "total_payout_percent": 80,
      "ticket_tier_percent": 0,
      "guaranteed_minimum": null,
      "position_prizes": null,
      "created_by": "admin-uuid",
      "created_at": "2026-07-31T09:00:00Z"
    },
    "current_registered_count": 15,
    "questions": [
      {
        "id": "q-uuid-1",
        "question": "What is 2 + 2?",
        "format": "multiple_choice",
        "options": ["3", "4", "5"],
        "correct_answer": "4",
        "order_index": 1
      },
      ...
    ]
  }
}

Example Usage (curl):
  curl -X GET 'https://bitlyf-iiek.onrender.com/api/admin/blitz/4ca7fc47-084d-45f3-919f-e490137c39e6' \
    -H "Authorization: Bearer YOUR_ADMIN_TOKEN"


ENDPOINT 2: PATCH /api/admin/blitz/:id
========================================

Description:
  Edit tournament with strict all-or-nothing lock.
  
Lock Rules:
  - If registered_count > 0: REJECT entire request
    Error: "Cannot edit — 5 players have already registered"
  - If registered_count === 0: Apply update normally
  - NEVER allow editing prize_pool or title (explicitly blocked)

Allowed Fields:
  - entry_fee (integer, >= 0)
  - question_count (integer, 1-100)
  - max_participants (integer, 1-10000)
  - registration_start (ISO timestamp)

Protected Fields (cannot be edited):
  - prize_pool (always blocked)
  - title (always blocked)

URL:
  PATCH https://bitlyf-iiek.onrender.com/api/admin/blitz/:tournamentId

Auth:
  Required: adminAuth middleware

Request Body:
{
  "entry_fee": 2000,
  "question_count": 12,
  "max_participants": 75
}

Response (200 OK) — Success with no players:
{
  "success": true,
  "data": {
    "tournament": {
      "id": "tournament-id",
      "entry_fee": 2000,
      "question_count": 12,
      "max_participants": 75,
      ...
    },
    "audit": {
      "changes_count": 3,
      "registered_players_at_edit": 0
    }
  }
}

Response (409 Conflict) — Players already registered:
{
  "success": false,
  "error": "Cannot edit — 5 players have already registered"
}

Response (400 Bad Request) — Trying to edit protected field:
{
  "success": false,
  "error": "Cannot edit prize_pool or title through this endpoint. These fields are protected."
}

Response (400 Bad Request) — Invalid field value:
{
  "success": false,
  "error": "question_count must be between 1 and 100"
}

Example Usage (curl):
  curl -X PATCH 'https://bitlyf-iiek.onrender.com/api/admin/blitz/4ca7fc47-084d-45f3-919f-e490137c39e6' \
    -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "entry_fee": 2000,
      "question_count": 12,
      "max_participants": 75
    }'


AUDIT TRAIL
===========

All changes via PATCH are logged to admin_audit_log table.

Schema:
  {
    "admin_id": "admin-uuid",
    "action": "blitz_tournament_edit",
    "object_id": "tournament-id",
    "object_type": "blitz_tournament",
    "details": {
      "field": "entry_fee",
      "old_value": 1000,
      "new_value": 2000,
      "tournament_title": "Weekly Blitz #1",
      "registered_count_at_edit": 0
    },
    "created_at": "2026-07-31T10:15:00Z"
  }


LOCK MECHANISM EXPLAINED
=========================

Why All-or-Nothing?
  Once players have registered, the tournament rules must be locked to prevent:
  - Changing entry fee after payment (unfair to earlier registrants)
  - Changing question count mid-registration (breaks fairness)
  - Changing max_participants after selection (unfair seeding impact)

How It Works:
  1. Admin calls PATCH /api/admin/blitz/:id with updates
  2. System queries blitz_registrations table for real-time player count
  3. If count > 0: Return 409 error immediately (no changes applied)
  4. If count === 0: All updates applied atomically
  5. Audit log entry created for each field changed

No Partial Updates:
  If admin tries to update 3 fields and registration count is 0:
    → All 3 fields updated successfully
  If admin tries to update 3 fields and registration count is > 0:
    → 0 fields updated, error returned
  Never: "2 fields updated, 1 rejected"


TESTING
=======

Test script: server/test_blitz_admin_endpoints.js

Run:
  cd server
  node test_blitz_admin_endpoints.js

Verifies:
  ✓ GET /api/admin/blitz/:id returns full config + registered count
  ✓ PATCH succeeds when registered_count === 0
  ✓ PATCH rejects when registered_count > 0
  ✓ prize_pool and title are protected
  ✓ Allowed fields update correctly
  ✓ Audit trail entries created


DEPLOYMENT STATUS
=================

Commit: 9e0dc15
Deployed to: main branch (Render auto-deploys)
Status: ✓ Ready for production

Files Modified:
  - server/src/routes/adminBlitz.js (enhanced GET, added PATCH)

Files Added:
  - server/test_blitz_admin_endpoints.js (test suite)


FRONTEND INTEGRATION
====================

For admin dashboard, use these endpoints to:

1. Load tournament details:
   GET /api/admin/blitz/:id

2. Edit tournament before players register:
   PATCH /api/admin/blitz/:id with allowed fields

3. Handle responses:
   - 409: Show "Cannot edit — N players registered" (disable form)
   - 400: Show field validation error
   - 200: Show "Tournament updated successfully"


IMPLEMENTATION DETAILS
======================

GET Enhancement:
  - Fetches current registered count from blitz_registrations in real-time
  - Returns all tournament config fields needed by admin
  - Includes questions array for question editor

PATCH Implementation:
  1. Validate tournament exists
  2. Count real registrations (atomic snapshot at request time)
  3. Check lock: if count > 0, reject immediately
  4. Whitelist fields: only allow entry_fee, question_count, max_participants, registration_start
  5. Validate field values: entry_fee >= 0, question_count 1-100, max_participants 1-10000
  6. Reject if user tries to edit prize_pool or title
  7. Apply all updates atomically (all-or-nothing)
  8. Create audit log entries for each changed field
  9. Return updated tournament + audit metadata

Field Validation:
  - entry_fee: Number, >= 0
  - question_count: Number, 1 to 100
  - max_participants: Number, 1 to 10000
  - registration_start: Valid ISO timestamp


EDGE CASES HANDLED
==================

Race condition prevention:
  - Real-time registration count checked at request time
  - Not cached or approximated
  - Single database query for count atomically validates lock

Protected fields:
  - prize_pool: Cannot be edited (prevents platform revenue manipulation)
  - title: Cannot be edited (prevents confusion about tournament identity)
  - These are explicitly checked and rejected if present in request

Partial updates:
  - If one field has invalid value, entire request rejected
  - Example: entry_fee=invalid + question_count=15
    → Neither field is updated, error returned

Audit logging:
  - Each field change logged separately for traceability
  - registered_count_at_edit captured for context
  - Admin ID recorded (from JWT)
  - If audit insert fails, update still succeeds (non-blocking)
