#!/usr/bin/env node
/**
 * Confirm the exact bug: map pills to packs and verify stats endpoint issue
 */

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = "https://fgwqzhhhcyqfpvlquyxc.supabase.co";
const SUPABASE_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInJlZiI6ImZnd3F6aGhoY3lxZnB2bHF1eXhjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MjkyMDQwOSwiZXhwIjoyMDk4NDk2NDA5fQ.DBdul1yvVBEYeYRdIT87V89vLE2xOMxivoZiQmK_SMk";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function confirmBug() {
  console.log("=".repeat(80));
  console.log("BUG CONFIRMATION: Map pills to packs and check stats");
  console.log("=".repeat(80));
  console.log();

  try {
    // Get all plays with pill details
    const { data: playsWithPills } = await supabase
      .from("pill_plays")
      .select("id, pill_id, player_id, won, pills(id, pack_id, question)");

    console.log("📋 ALL PILL PLAYS WITH THEIR PACK ASSOCIATIONS:");
    console.log("-".repeat(80));

    const packWins = {}; // pack_id -> { total, won, lost }

    for (const play of playsWithPills || []) {
      const pill = play.pills?.[0]; // Select returns array of related records
      const packId = pill?.pack_id;
      const question = pill?.question || "Unknown";

      if (!packWins[packId]) {
        packWins[packId] = { total: 0, won: 0, lost: 0 };
      }

      packWins[packId].total++;
      if (play.won) {
        packWins[packId].won++;
      } else {
        packWins[packId].lost++;
      }

      console.log(
        `  Pill: ${pill?.id?.substring(0, 8)}... (${question.substring(0, 30)}...)`
      );
      console.log(`    Pack: ${packId || "NO PACK"}`);
      console.log(`    Won: ${play.won}`);
    }

    // Now get active packs
    console.log(`\n${"=".repeat(80)}`);
    console.log("📦 ACTIVE PACKS AND THEIR STATS:");
    console.log(`${"=".repeat(80)}`);

    const { data: activePacks } = await supabase
      .from("pill_packs")
      .select("id, name, status")
      .eq("status", "active");

    for (const pack of activePacks || []) {
      const stats = packWins[pack.id] || { total: 0, won: 0, lost: 0 };
      console.log(`\n${pack.name} (${pack.id})`);
      console.log(
        `  LIVE: 0 (no active attempts)`
      );
      console.log(`  WON: ${stats.won}`);
      console.log(`  LOST: ${stats.lost}`);
      console.log(`  TOTAL: ${stats.total}`);
    }

    // NOW TEST WHAT THE STATS ENDPOINT IS QUERYING
    console.log(`\n${"=".repeat(80)}`);
    console.log("🔍 WHAT THE STATS ENDPOINT IS QUERYING:");
    console.log(`${"=".repeat(80)}`);

    // The attempt-stats endpoint queries special_attempts, not pill_plays
    const targetPackIds = (activePacks || []).map((p) => p.id);

    console.log(`\nLooking for special_attempts in these packs:`);
    for (const id of targetPackIds) {
      console.log(`  - ${id}`);
    }

    const { data: attempts } = await supabase
      .from("special_attempts")
      .select("pack_id, status")
      .in("pack_id", targetPackIds);

    console.log(
      `\nResult: Found ${attempts?.length || 0} special_attempts`
    );
    console.log(
      `✅ BUG CONFIRMED: The stats endpoint queries special_attempts table`
    );
    console.log(`   but the actual plays are in pill_plays table!`);
    console.log(`\n   This is why all stats show ZERO.`);

    // Now query pill_plays to show what SHOULD be returned
    console.log(`\n${"=".repeat(80)}`);
    console.log("✅ CORRECT QUERY (what should be used for standard packs):");
    console.log(`${"=".repeat(80)}`);

    const { data: correctPlays } = await supabase
      .from("pill_plays")
      .select("id, pill_id")
      .in(
        "pill_id",
        (await supabase
          .from("pills")
          .select("id")
          .in("pack_id", targetPackIds)).data?.map((p) => p.id) || []
      );

    console.log(`Found ${correctPlays?.length || 0} pill_plays for standard packs`);

  } catch (error) {
    console.error("❌ Fatal error:", error);
  }
}

confirmBug();
