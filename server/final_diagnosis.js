#!/usr/bin/env node
/**
 * Final diagnosis: Show exact plays for each active pack
 */

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = "https://fgwqzhhhcyqfpvlquyxc.supabase.co";
const SUPABASE_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInJlZiI6ImZnd3F6aGhoY3lxZnB2bHF1eXhjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MjkyMDQwOSwiZXhwIjoyMDk4NDk2NDA5fQ.DBdul1yvVBEYeYRdIT87V89vLE2xOMxivoZiQmK_SMk";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function finalDiagnosis() {
  console.log("=".repeat(80));
  console.log("FINAL DIAGNOSIS: Stats Endpoint Bug");
  console.log("=".repeat(80));
  console.log();

  try {
    // Get active packs
    const { data: activePacks } = await supabase
      .from("pill_packs")
      .select("id, name, status, pack_type, is_vip")
      .eq("status", "active");

    console.log("Active Packs:");
    for (const pack of activePacks || []) {
      console.log(`  - ${pack.name}: type=${pack.pack_type}, is_vip=${pack.is_vip}`);
    }

    // For each active pack, find its pills
    console.log(`\n${"=".repeat(80)}`);
    console.log("Pills per Pack:");
    console.log("=".repeat(80));

    for (const pack of activePacks || []) {
      const { data: packPills } = await supabase
        .from("pills")
        .select("id, question, status")
        .eq("pack_id", pack.id);

      console.log(`\n${pack.name} (${pack.id}):`);
      console.log(`  Pills: ${packPills?.length || 0}`);

      if (packPills && packPills.length > 0) {
        // Get plays for these pills
        const pillIds = packPills.map((p) => p.id);
        const { data: plays } = await supabase
          .from("pill_plays")
          .select("id, pill_id, won")
          .in("pill_id", pillIds);

        console.log(`  Plays: ${plays?.length || 0}`);
        if (plays && plays.length > 0) {
          const wonCount = plays.filter((p) => p.won).length;
          const lostCount = plays.filter((p) => !p.won).length;
          console.log(`    Won: ${wonCount}`);
          console.log(`    Lost: ${lostCount}`);
        }
      }
    }

    // NOW SHOW THE BUG
    console.log(`\n${"=".repeat(80)}`);
    console.log("THE BUG:");
    console.log("=".repeat(80));

    const packIds = (activePacks || []).map((p) => p.id);
    console.log(`\nThe stats endpoint queries special_attempts with:`);
    console.log(`  targetPackIds: [${packIds.slice(0, 2).join(", ")}...]`);
    console.log(`  Query: special_attempts.in('pack_id', targetPackIds)`);

    const { data: specialAttempts } = await supabase
      .from("special_attempts")
      .select("id")
      .in("pack_id", packIds);

    console.log(`  Result: ${specialAttempts?.length || 0} records`);
    console.log(`\n✅ ROOT CAUSE:`);
    console.log(
      `   The stats endpoint ONLY queries special_attempts table.`
    );
    console.log(
      `   It does NOT query pill_plays table where standard pack plays are stored.`
    );
    console.log(
      `   Since all active packs are "standard" (pack_type not 'special' or is_vip=false),`
    );
    console.log(`   their plays are stored in pill_plays, not special_attempts.`);
    console.log(
      `   Therefore, all standard packs always show 0 for LIVE/WON/LOST/TOTAL.`
    );

    console.log(`\n${"=".repeat(80)}`);
    console.log("ACTUAL STATS (what should be displayed):");
    console.log("=".repeat(80));

    for (const pack of activePacks || []) {
      const { data: packPills } = await supabase
        .from("pills")
        .select("id")
        .eq("pack_id", pack.id);

      if (packPills && packPills.length > 0) {
        const pillIds = packPills.map((p) => p.id);
        const { data: plays } = await supabase
          .from("pill_plays")
          .select("won")
          .in("pill_id", pillIds);

        const wonCount = (plays || []).filter((p) => p.won).length;
        const lostCount = (plays || []).filter((p) => !p.won).length;
        const totalPlays = plays?.length || 0;

        console.log(`\n${pack.name}:`);
        console.log(`  LIVE: 0 (no active attempts)`);
        console.log(`  WON: ${wonCount}`);
        console.log(`  LOST: ${lostCount}`);
        console.log(`  TOTAL: ${totalPlays}`);
      }
    }
  } catch (error) {
    console.error("❌ Fatal error:", error);
  }
}

finalDiagnosis();
