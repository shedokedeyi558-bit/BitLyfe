#!/usr/bin/env node
/**
 * Investigation script: Query pill pack stats from Supabase
 * Shows real database data for packs and their associated pills, plays, and attempts
 */

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = "https://fgwqzhhhcyqfpvlquyxc.supabase.co";
const SUPABASE_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZnd3F6aGhoY3lxZnB2bHF1eXhjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MjkyMDQwOSwiZXhwIjoyMDk4NDk2NDA5fQ.DBdul1yvVBEYeYRdIT87V89vLE2xOMxivoZiQmK_SMk";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function investigatePackStats() {
  console.log("=".repeat(80));
  console.log("PACK STATS INVESTIGATION - Querying Real Database Data");
  console.log("=".repeat(80));
  console.log();

  try {
    // 1. Get all active packs, ordered by most recent creation
    console.log("📦 FETCHING PACKS...");
    const { data: packs, error: packsError } = await supabase
      .from("pill_packs")
      .select("*")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(5);

    if (packsError) {
      console.error("❌ Error fetching packs:", packsError);
      return;
    }

    if (!packs || packs.length === 0) {
      console.log("⚠️  No active packs found");
      return;
    }

    console.log(`✓ Found ${packs.length} active pack(s)\n`);

    // 2. For each pack, gather stats
    for (const pack of packs) {
      console.log(`\n${"─".repeat(80)}`);
      console.log(`PACK: ${pack.name} (ID: ${pack.id})`);
      console.log(`${"─".repeat(80)}`);
      console.log(`  Type: ${pack.pack_type || "standard"}`);
      console.log(`  Status: ${pack.status}`);
      console.log(`  Entry Fee: ₦${pack.entry_fee || "N/A"}`);
      console.log(`  Prize: ₦${pack.prize || "N/A"}`);
      console.log(`  Created: ${new Date(pack.created_at).toISOString()}`);

      // Get pills in this pack
      const { data: pills, error: pillsError } = await supabase
        .from("pills")
        .select("id, status, category")
        .eq("pack_id", pack.id);

      if (pillsError) {
        console.error("  ❌ Error fetching pills:", pillsError);
        continue;
      }

      const availablePills = pills.filter((p) => p.status === "available").length;
      const playedPills = pills.filter((p) => p.status === "played").length;

      console.log(`\n  📋 PILLS IN PACK:`);
      console.log(`    • Available: ${availablePills}`);
      console.log(`    • Played: ${playedPills}`);
      console.log(`    • Total: ${pills.length}`);

      // Get plays data for these pills
      if (pills.length > 0) {
        const pillIds = pills.map((p) => p.id);

        // Query pill_plays for these pills
        const { data: plays, error: playsError } = await supabase
          .from("pill_plays")
          .select("id, won")
          .in("pill_id", pillIds);

        if (playsError) {
          console.error("  ❌ Error fetching plays:", playsError);
        } else {
          const wonCount = plays.filter((p) => p.won === true).length;
          const lostCount = plays.filter((p) => p.won === false).length;
          const totalPlays = plays.length;

          console.log(`\n  🎮 PLAYS STATISTICS:`);
          console.log(`    • Total Plays: ${totalPlays}`);
          console.log(`    • Won: ${wonCount}`);
          console.log(`    • Lost: ${lostCount}`);
        }
      }

      // If special pack, get special_attempts
      if (pack.pack_type === "special") {
        console.log(`\n  🔬 SPECIAL PACK STATS:`);
        const { data: attempts, error: attemptsError } = await supabase
          .from("special_attempts")
          .select("id, status, correct_count")
          .eq("pack_id", pack.id);

        if (attemptsError) {
          console.error(`    ❌ Error fetching attempts:`, attemptsError);
        } else {
          const passed = attempts.filter((a) => a.status === "passed").length;
          const failed = attempts.filter((a) => a.status === "failed").length;
          const inProgress = attempts.filter(
            (a) => a.status === "in_progress"
          ).length;

          console.log(`    • Total Attempts: ${attempts.length}`);
          console.log(`    • Passed: ${passed}`);
          console.log(`    • Failed: ${failed}`);
          console.log(`    • In Progress: ${inProgress}`);
        }
      }

      // If VIP pack, get vip_attempts
      if (pack.is_vip || pack.pack_type === "vip") {
        console.log(`\n  👑 VIP PACK STATS:`);
        const { data: attempts, error: attemptsError } = await supabase
          .from("vip_attempts")
          .select("id, status")
          .eq("pack_id", pack.id);

        if (attemptsError) {
          console.error(`    ❌ Error fetching VIP attempts:`, attemptsError);
        } else {
          const won = attempts.filter((a) => a.status === "won").length;
          const failed = attempts.filter((a) => a.status === "failed").length;
          const inProgress = attempts.filter(
            (a) => a.status === "in_progress"
          ).length;

          console.log(`    • Total Attempts: ${attempts.length}`);
          console.log(`    • Won: ${won}`);
          console.log(`    • Failed: ${failed}`);
          console.log(`    • In Progress: ${inProgress}`);
        }
      }
    }

    console.log(`\n${"=".repeat(80)}`);
    console.log("INVESTIGATION COMPLETE");
    console.log("=".repeat(80));
  } catch (error) {
    console.error("❌ Fatal error:", error);
  }
}

investigatePackStats();
