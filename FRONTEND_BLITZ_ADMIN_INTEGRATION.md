FRONTEND: BLITZ ADMIN TOURNAMENT EDITOR
========================================

Two endpoints are now available for your admin dashboard.


ENDPOINT 1: FETCH TOURNAMENT DETAILS
====================================

Endpoint:
  GET /api/admin/blitz/:tournamentId

Headers:
  Authorization: Bearer {adminToken}

Response:
  {
    "success": true,
    "data": {
      "tournament": { ...full config... },
      "current_registered_count": 5,
      "questions": [ ...array... ]
    }
  }

Key Fields to Display:
  - tournament.title
  - tournament.entry_fee (in Naira)
  - tournament.question_count
  - tournament.max_participants
  - tournament.prize_pool
  - tournament.payout_distribution
  - tournament.registration_start
  - tournament.tournament_start
  - tournament.status
  - current_registered_count

Example:
  const response = await fetch('/api/admin/blitz/tournament-id', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const { data } = await response.json();
  
  // Display tournament info
  console.log(`${data.tournament.title} - ${data.current_registered_count} registered`);


ENDPOINT 2: EDIT TOURNAMENT
===========================

Endpoint:
  PATCH /api/admin/blitz/:tournamentId

Headers:
  Authorization: Bearer {adminToken}
  Content-Type: application/json

Allowed Fields:
  - entry_fee (number, >= 0)
  - question_count (number, 1-100)
  - max_participants (number, 1-10000)
  - registration_start (ISO timestamp string)

Request:
  {
    "entry_fee": 2000,
    "question_count": 12,
    "max_participants": 100
  }

Response (200 OK):
  {
    "success": true,
    "data": {
      "tournament": { ...updated config... },
      "audit": {
        "changes_count": 3,
        "registered_players_at_edit": 0
      }
    }
  }

Response (409 Conflict) - Players registered:
  {
    "success": false,
    "error": "Cannot edit — 5 players have already registered"
  }

Response (400 Bad Request) - Invalid field:
  {
    "success": false,
    "error": "question_count must be between 1 and 100"
  }

Example:
  const response = await fetch('/api/admin/blitz/tournament-id', {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      entry_fee: 2000,
      question_count: 12
    })
  });
  
  if (response.status === 409) {
    // Show: "Cannot edit — players already registered"
  } else if (response.ok) {
    // Show: "Tournament updated successfully"
  }


UI BEHAVIOR
===========

Show Edit Form When:
  - Tournament status === 'draft'
  - current_registered_count === 0

Disable Edit Form When:
  - current_registered_count > 0
  - Show message: "Cannot edit — tournament has registered players"

Form Fields:
  - Entry Fee (₦) [number input, min 0]
  - Question Count [number input, 1-100]
  - Max Participants [number input, 1-10000]
  - Registration Deadline [datetime picker]

Protected (Read-Only):
  - Prize Pool
  - Tournament Title
  - Payout Distribution
  - Notes: "These fields cannot be edited once created"

Error Handling:
  if (error.status === 409) {
    showError(error.message);
    // "Cannot edit — 5 players have already registered"
    disableForm();
  } else if (error.status === 400) {
    showFieldError(error.message);
    // "question_count must be between 1 and 100"
  } else {
    showError("Failed to update tournament");
  }

Success Message:
  "Tournament updated successfully"
  Show which fields changed:
  "Updated: entry_fee (₦1000 → ₦2000), question_count (10 → 12)"


REFRESH BEHAVIOR
================

After fetching tournament:
  - Display current_registered_count
  - If count > 0, disable edit form with lock message
  - If count === 0, enable edit form

On Successful Edit (200 OK):
  - Update displayed fields
  - Refresh registration count
  - Show success notification

On Conflict Error (409):
  - Show error message
  - Disable form (tournament is now locked)
  - Offer refresh button


FIELD CONSTRAINTS REFERENCE
===========================

entry_fee:
  - Type: Number (integer)
  - Min: 0 (free tournament allowed)
  - Max: Unlimited (recommended < 1M Naira)
  - Format: Display as ₦entry_fee in UI

question_count:
  - Type: Number (integer)
  - Min: 1
  - Max: 100
  - Error if < 1 or > 100: Show "Must be between 1 and 100"

max_participants:
  - Type: Number (integer)
  - Min: 1
  - Max: 10000
  - Error if < 1 or > 10000: Show "Must be between 1 and 10000"
  - Warning if > 50: Show "Large tournaments may have slower performance"

registration_start:
  - Type: ISO timestamp string
  - Format: "2026-07-31T10:00:00Z"
  - Validate: Must be a valid date
  - Validate: Must be before tournament_start


EXAMPLES
========

Example 1: Load and Display Tournament
  async function loadTournament(id) {
    const res = await fetch(`/api/admin/blitz/${id}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const { data } = await res.json();
    
    document.getElementById('title').textContent = data.tournament.title;
    document.getElementById('entry-fee').value = data.tournament.entry_fee;
    document.getElementById('registered').textContent = `${data.current_registered_count} players`;
    
    if (data.current_registered_count > 0) {
      disableEditForm();
    }
  }

Example 2: Update Tournament
  async function updateTournament(id, updates) {
    const res = await fetch(`/api/admin/blitz/${id}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updates)
    });
    
    if (res.status === 409) {
      const { error } = await res.json();
      showError(error); // "Cannot edit — N players have already registered"
      disableEditForm();
      return;
    }
    
    if (res.ok) {
      const { data } = await res.json();
      showSuccess(`Updated ${data.audit.changes_count} field(s)`);
      loadTournament(id); // Refresh display
      return;
    }
    
    if (res.status === 400) {
      const { error } = await res.json();
      showError(error); // "question_count must be between 1 and 100"
    }
  }

Example 3: Form Submission
  document.getElementById('edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const formData = {
      entry_fee: parseInt(document.getElementById('entry-fee').value),
      question_count: parseInt(document.getElementById('question-count').value),
      max_participants: parseInt(document.getElementById('max-participants').value)
    };
    
    // Remove fields with unchanged values to minimize audit entries
    const currentTournament = window.currentTournament;
    const updates = {};
    for (const [key, value] of Object.entries(formData)) {
      if (value !== currentTournament[key]) {
        updates[key] = value;
      }
    }
    
    if (Object.keys(updates).length === 0) {
      showInfo("No changes to save");
      return;
    }
    
    await updateTournament(window.tournamentId, updates);
  });


INTEGRATION CHECKLIST
=====================

☐ Display tournament title, entry fee, participant limits
☐ Show current registered player count
☐ Disable edit form if registered_count > 0 with explanation
☐ Implement form for: entry_fee, question_count, max_participants, registration_start
☐ Add field validation constraints before submit
☐ Handle 409 conflict (players registered)
☐ Handle 400 validation error
☐ Show success message with field change summary
☐ Show "Read-only" labels on prize_pool and title
☐ Add refresh button to sync latest registration count
☐ Test: Edit tournament with 0 players (should succeed)
☐ Test: Edit tournament with > 0 players (should fail with 409)
