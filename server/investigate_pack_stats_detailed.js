#!/usr/bin/env node
/**
 * Detailed Investigation: Check if the zeros are due to:
 * 1. No data in pill_plays table
 * 2. Incorrect stats endpoint queries
 * 3. Missing relationships/foreign key issues
 */

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = "https://fgwqzhhhcyqfpvlquyxc.supabase.co";
const SUPABASE_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZnd3F6aGhoY3lxZnB2bHF1eXhjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MjkyMDQwOSwiZXhwIjoyMDk4NDk2NDA5fQ.DBdul1yvVBEYeYRdIT87V89vLE2xOMxivoZiQmK_SMk";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function investigateDetailed() {
  console.log("=".repeat(80));
  console.log("DETAILED PACK STATS INVESTIGATION");
  console.log("=".repeat(80));
  console.log();

  try {
    // 1. Check overall pill_plays table
    console.log("1️⃣  CHECKING OVERALL pill_plays TABLE");
    console.log("-".repeat(80));
    const { data: allPlays, error: allPlaysErr } = await supabase
      .from("pill_plays")
      .select("id, pill_id, player_id, won, created_at", { count: "exact" });

    if (allPlaysErr) {
      console.error("❌ Error fetching all plays:", allPlaysErr);
    } else {
      console.log(`Total pill_plays records: ${allPlays?.length || 0}`);
      if (allPlays && allPlays.length > 0) {
        console.log(`  First play:`, JSON.stringify(allPlays[0], null, 2));
      } else {
        console.log(
          "  ⚠️  NO PLAYS IN DATABASE - This explains the zeros!\n"
        );
      }
    }

    // 2. Check pills table
    console.log("\n2️⃣  CHECKING PILLS TABLE");
    console.log("-".repeat(80));
    const { data: allPills, error: pillsErr } = await supabase
      .from("pills")
      .select("id, pack_id, status, created_at", { count: "exact" });

    if (pillsErr) {
      console.error("❌ Error fetching pills:", pillsErr);
    } else {
      console.log(`Total pills: ${allPills?.length || 0}`);
      const statusCounts = {};
      for (const pill of allPills || []) {
        statusCounts[pill.status] = (statusCounts[pill.status] || 0) + 1;
      }
      console.log("Pills by status:", statusCounts);
    }

    // 3. Check pack details
    console.log("\n3️⃣  CHECKING PILL_PACKS TABLE");
    console.log("-".repeat(80));
    const { data: allPacks, error: packsErr } = await supabase
      .from("pill_packs")
      .select("id, name, status, pack_type, created_at");

    if (packsErr) {
      console.error("❌ Error fetching packs:", packsErr);
    } else {
      console.log(`Total packs: ${allPacks?.length || 0}`);
      for (const pack of allPacks || []) {
        console.log(
          `  - ${pack.name} (${pack.pack_type || "standard"}): ${pack.status}`
        );
      }
    }

    // 4. Check if there are any attempts (special/vip)
    console.log("\n4️⃣  CHECKING SPECIAL_ATTEMPTS TABLE");
    console.log("-".repeat(80));
    const { data: specialAttempts, error: specialErr } = await supabase
      .from("special_attempts")
      .select("id, pack_id, status, created_at", { count: "exact" });

    if (specialErr) {
      console.error("❌ Error fetching special attempts:", specialErr);
    } else {
      console.log(`Total special_attempts: ${specialAttempts?.length || 0}`);
      if (specialAttempts && specialAttempts.length > 0) {
        console.log(`  Sample:`, JSON.stringify(specialAttempts[0], null, 2));
      }
    }

    // 5. Check vip_attempts
    console.log("\n5️⃣  CHECKING VIP_ATTEMPTS TABLE");
    console.log("-".repeat(80));
    const { data: vipAttempts, error: vipErr } = await supabase
      .from("vip_attempts")
      .select("id, pack_id, status, created_at", { count: "exact" });

    if (vipErr) {
      console.error("❌ Error fetching VIP attempts:", vipErr);
    } else {
      console.log(`Total vip_attempts: ${vipAttempts?.length || 0}`);
      if (vipAttempts && vipAttempts.length > 0) {
        console.log(`  Sample:`, JSON.stringify(vipAttempts[0], null, 2));
      }
    }

    // 6. Check players table
    console.log("\n6️⃣  CHECKING PLAYERS TABLE");
    console.log("-".repeat(80));
    const { data: players, error: playersErr } = await supabase
      .from("players")
      .select("id, name, games_played, games_won", { count: "exact" });

    if (playersErr) {
      console.error("❌ Error fetching players:", playersErr);
    } else {
      console.log(`Total players: ${players?.length || 0}`);
      if (players && players.length > 0) {
        console.log(`  Sample players (first 3):`);
        for (const p of players.slice(0, 3)) {
          console.log(
            `    - ${p.name || p.id}: games_played=${p.games_played}, games_won=${p.games_won}`
          );
        }
      }
    }

    // 7. Diagnosis
    console.log("\n" + "=".repeat(80));
    console.log("📊 DIAGNOSIS");
    console.log("=".repeat(80));

    const playCount = allPlays?.length || 0;
    const pillCount = allPills?.length || 0;
    const packCount = allPacks?.length || 0;
    const playerCount = players?.length || 0;
    const specialCount = specialAttempts?.length || 0;
    const vipCount = vipAttempts?.length || 0;

    console.log(`\nDatabase State Summary:`);
    console.log(`  • Players: ${playerCount}`);
    console.log(`  • Packs: ${packCount}`);
    console.log(`  • Pills: ${pillCount}`);
    console.log(`  • Pill Plays: ${playCount}`);
    console.log(`  • Special Attempts: ${specialCount}`);
    console.log(`  • VIP Attempts: ${vipCount}`);

    if (playCount === 0 && pillCount > 0 && packCount > 0) {
      console.log(
        `\n✅ ROOT CAUSE IDENTIFIED: Database has packs and pills but NO plays.`
      );
      console.log(
        `   This means either:`
      );
      console.log(`   1. No players have played any pills yet`);
      console.log(
        `   2. Pill plays are being deleted/reset somewhere`
      );
      console.log(`   3. The frontend never calls the pill/open or pill/submit endpoints`);
    } else if (playCount > 0) {
      console.log(
        `\n⚠️  Database HAS plays (${playCount}), so the zeros are a stats calculation bug.`
      );
      console.log(
        `   Next step: Check if stats endpoints are querying correctly.`
      );
    } else {
      console.log(`\n❌ Unexpected state: All tables are empty!`);
    }

    // 8. If there are plays, try to replicate stats endpoint query
    if (playCount > 0) {
      console.log(`\n${"=".repeat(80)}`);
      console.log("8️⃣  TESTING STATS ENDPOINT LOGIC");
      console.log(`${"=".repeat(80)}`);

      // Test the attempt-stats endpoint query for a pack
      const { data: activePacks } = await supabase
        .from("pill_packs")
        .select("id")
        .eq("status", "active")
        .or("pack_type.eq.special,is_vip.eq.true");

      if (activePacks && activePacks.length > 0) {
        const packIds = activePacks.map((p) => p.id);
        console.log(`\nQuerying special_attempts for ${packIds.length} packs:`);

        const { data: attempts } = await supabase
          .from("special_attempts")
          .select("pack_id, status")
          .in("pack_id", packIds);

        console.log(
          `  Attempts found: ${attempts?.length || 0}`
        );
        if (attempts && attempts.length > 0) {
          const byStatus = {};
          for (const a of attempts) {
            byStatus[a.status] = (byStatus[a.status] || 0) + 1;
          }
          console.log(`  By status:`, byStatus);
        }
      }
    }

    console.log(`\n${"=".repeat(80)}`);
    console.log("INVESTIGATION COMPLETE");
    console.log(`${"=".repeat(80)}`);
  } catch (error) {
    console.error("❌ Fatal error:", error);
  }
}

investigateDetailed();
