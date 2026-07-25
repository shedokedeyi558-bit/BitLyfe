# Max Entries API Response Examples

## Admin: Create Pack with Entry Cap

### Request
```bash
POST /api/admin/pills/packs
Content-Type: application/json
Authorization: Bearer <admin_token>

{
  "name": "Weekly Challenge Special",
  "pack_type": "special",
  "category": "Sports",
  "question_count": 10,
  "total_time_seconds": 600,
  "required_correct": 7,
  "entry_fee": 500,
  "prize": 5000,
  "quiz_expires_at": "2026-07-31T23:59:59Z",
  "max_entries": 50,
  "target_bank_size": 150
}
```

### Response (201 Created)
```json
{
  "success": true,
  "data": {
    "pack": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "Weekly Challenge Special",
      "category": "Sports",
      "status": "draft",
      "pack_type": "special",
      "is_vip": false,
      "entry_fee": "500.00",
      "prize": "5000.00",
      "question_count": 10,
      "total_time_seconds": 600,
      "required_correct": 7,
      "entry_window_end": null,
      "quiz_expires_at": "2026-07-31T23:59:59Z",
      "max_entries": 50,
      "current_entries": 0,
      "target_bank_size": 150,
      "created_at": "2026-07-25T10:30:00Z",
      "pills": []
    }
  }
}
```

## Admin: Update Pack Entry Cap

### Request
```bash
PUT /api/admin/pills/packs/550e8400-e29b-41d4-a716-446655440000
Content-Type: application/json
Authorization: Bearer <admin_token>

{
  "max_entries": 75
}
```

### Response (200 OK)
```json
{
  "success": true,
  "data": {
    "pack": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "Weekly Challenge Special",
      "category": "Sports",
      "status": "active",
      "max_entries": 75,
      "current_entries": 23,
      "quiz_expires_at": "2026-07-31T23:59:59Z",
      "...": "... other fields ..."
    }
  }
}
```

## Admin: Remove Entry Cap

### Request
```bash
PUT /api/admin/pills/packs/550e8400-e29b-41d4-a716-446655440000
Content-Type: application/json
Authorization: Bearer <admin_token>

{
  "max_entries": null
}
```

### Response (200 OK)
```json
{
  "success": true,
  "data": {
    "pack": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "Weekly Challenge Special",
      "max_entries": null,
      "current_entries": 23,
      "...": "..."
    }
  }
}
```

## Admin: List All Packs (showing entry cap info)

### Request
```bash
GET /api/admin/pills/packs
Authorization: Bearer <admin_token>
```

### Response (200 OK)
```json
{
  "success": true,
  "data": {
    "packs": [
      {
        "id": "550e8400-e29b-41d4-a716-446655440000",
        "name": "Weekly Challenge Special",
        "category": "Sports",
        "status": "active",
        "pack_type": "special",
        "is_vip": false,
        "entry_fee": "500.00",
        "prize": "5000.00",
        "question_count": 10,
        "total_time_seconds": 600,
        "required_correct": 7,
        "quiz_expires_at": "2026-07-31T23:59:59Z",
        "quiz_expired": false,
        "created_at": "2026-07-25T10:30:00Z",
        "pills": [
          {
            "id": "660e8400-e29b-41d4-a716-446655440001",
            "question": "What is the capital of France?",
            "format": "multiple_choice",
            "status": "available",
            "...": "..."
          }
        ],
        "available_count": 45,
        "played_count": 0,
        "expired_count": 0,
        "display_status": "active",
        "bank_ratio": 3.0,
        "low_entropy_warning": null,
        "recommended_bank_size": 30,
        "target_bank_size": 150,
        "target_bank_progress": {
          "current": 45,
          "target": 150,
          "percent": 30.0
        },
        // ── NEW ENTRY CAP FIELDS ──────────────────────────────────────
        "max_entries": 50,
        "current_entries": 23,
        "entries_remaining": 27,
        "entry_cap_reached": false
      },
      {
        "id": "770e8400-e29b-41d4-a716-446655440002",
        "name": "VIP Premium Pack",
        "status": "active",
        "pack_type": "special",
        "quiz_expires_at": "2026-08-15T23:59:59Z",
        "quiz_expired": false,
        "available_count": 60,
        "display_status": "active",
        // ── UNLIMITED (no entry cap) ───────────────────────────────────
        "max_entries": null,
        "current_entries": 156,
        "entries_remaining": null,
        "entry_cap_reached": false
      },
      {
        "id": "880e8400-e29b-41d4-a716-446655440003",
        "name": "Standard Pills Pack A",
        "status": "active",
        "pack_type": "standard",
        "quiz_expires_at": null,
        "quiz_expired": false,
        "available_count": 100,
        "display_status": "active",
        // ── STANDARD PACK (no entry cap fields used) ────────────────────
        "max_entries": null,
        "current_entries": null,
        "entries_remaining": null,
        "entry_cap_reached": false
      }
    ]
  }
}
```

## Player: Start Attempt (Entry Cap Not Reached)

### Request
```bash
POST /api/pills/special/start
Content-Type: application/json
Authorization: Bearer <player_token>

{
  "packId": "550e8400-e29b-41d4-a716-446655440000"
}
```

### Response (201 Created)
```json
{
  "success": true,
  "resumed": false,
  "attempt_id": "aa0e8400-e29b-41d4-a716-446655440010",
  "question": {
    "question_number": 1,
    "total_questions": 10,
    "id": "660e8400-e29b-41d4-a716-446655440001",
    "question": "What is the capital of France?",
    "format": "multiple_choice",
    "options": ["Paris", "Lyon", "Marseille", "Nice"],
    "color": "#8B5CF6"
  },
  "question_count": 10,
  "total_time_seconds": 600,
  "required_correct": 7,
  "time_remaining_seconds": 600,
  // ── NEW ENTRY CAP FIELDS ──────────────────────────────────────────
  "current_entries": 24,
  "max_entries": 50,
  "newBalance": 99500,
  "newBonusBalance": 0,
  "bonusUsed": 0
}
```

**Frontend can display**:
```
"24 of 50 entries available" 
or 
"Quiz: 24/50 entries used, 26 remaining"
```

## Player: Start Attempt (Entry Cap Reached)

### Request
```bash
POST /api/pills/special/start
Content-Type: application/json
Authorization: Bearer <player_token>

{
  "packId": "550e8400-e29b-41d4-a716-446655440000"
}
```

### Response (410 Gone)
```json
{
  "success": false,
  "code": "ENTRY_CAP_REACHED",
  "error": "This pack has reached its maximum entries (50). It is now closed.",
  "current_entries": 50,
  "max_entries": 50
}
```

**Frontend displays**:
```
"This pack has reached its maximum entries (50) and is now closed."
```

## Player: Start Attempt (Time-Based Expiry Still Works)

### Request
```bash
POST /api/pills/special/start
Content-Type: application/json
Authorization: Bearer <player_token>

{
  "packId": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Scenario**: quiz_expires_at already passed (e.g., 2026-07-20, but current time is 2026-07-25)

### Response (410 Gone)
```json
{
  "success": false,
  "code": "QUIZ_EXPIRED",
  "error": "This pack is no longer accepting new entries — it has ended."
}
```

## Player: Both Limits Set, Entry Cap Hits First

**Pack configuration**:
- quiz_expires_at: 2026-08-31
- max_entries: 50
- current_entries: 49 (49 players have started)

### Request (50th player)
```bash
POST /api/pills/special/start
...
```

### Response (201 Created)
```json
{
  "success": true,
  "resumed": false,
  "attempt_id": "...",
  "current_entries": 50,
  "max_entries": 50,
  "...": "..."
}
```

### Request (51st player, attempt 1 second later)
```bash
POST /api/pills/special/start
...
```

### Response (410 Gone)
```json
{
  "success": false,
  "code": "ENTRY_CAP_REACHED",
  "error": "This pack has reached its maximum entries (50). It is now closed.",
  "current_entries": 50,
  "max_entries": 50
}
```

**What happened**: Entry cap hit before time expiry, pack closes immediately.

## Player: Both Limits Set, Time Expiry Hits First

**Pack configuration**:
- quiz_expires_at: 2026-07-25T18:00:00Z (NOW IS 2026-07-25T18:05:00Z)
- max_entries: 100
- current_entries: 45 (45 players have started, still below cap)

### Request
```bash
POST /api/pills/special/start
...
```

### Response (410 Gone)
```json
{
  "success": false,
  "code": "QUIZ_EXPIRED",
  "error": "This pack is no longer accepting new entries — it has ended."
}
```

**What happened**: Time expired before entry cap was reached, pack closes due to time limit.

## Player: Unlimited Entry Cap (null max_entries)

**Pack configuration**:
- quiz_expires_at: 2026-08-31
- max_entries: null (unlimited)
- current_entries: 2000 (already accepted 2000 attempts)

### Request
```bash
POST /api/pills/special/start
...
```

### Response (201 Created)
```json
{
  "success": true,
  "resumed": false,
  "attempt_id": "...",
  "current_entries": 2001,
  "max_entries": null,
  "...": "..."
}
```

**What happened**: No entry cap, player's attempt succeeds. Only time-based expiry applies.

**Frontend can display**:
```
"Unlimited entries available" (since max_entries is null)
```

---

## Summary of Response Fields

### Admin Pack List (GET /api/admin/pills/packs)

**New fields per pack** (Specials only):
| Field | Type | Example | Notes |
|-------|------|---------|-------|
| `max_entries` | int \| null | 50 | Admin's configured cap (null = unlimited) |
| `current_entries` | int | 23 | Real-time entry count |
| `entries_remaining` | int \| null | 27 | max_entries - current_entries (null if no cap) |
| `entry_cap_reached` | boolean | false | true if current_entries >= max_entries |

**For standard packs**: All entry cap fields are null/false (ignored by frontend).

### Player Start Attempt (POST /api/pills/special/start)

**New fields**:
| Field | Type | Example | Notes |
|-------|------|---------|-------|
| `current_entries` | int | 24 | Real-time count when attempt created |
| `max_entries` | int \| null | 50 | Admin's cap for this pack (null = unlimited) |

### Player Error Response (Entry Cap Reached)

**Code**: `ENTRY_CAP_REACHED` (410 Gone)
**Fields**:
- `error`: User-friendly message
- `current_entries`: Current count
- `max_entries`: Configured cap

**Note**: Existing `QUIZ_EXPIRED` code (410 Gone) still works for time-based expiry.
