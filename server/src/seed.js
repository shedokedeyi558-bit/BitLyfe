require('dotenv').config();
const bcrypt = require('bcryptjs');
const supabase = require('./db/supabase');

async function seed() {
  console.log('🌱 Starting database seed...');

  try {
    // 1. Seed 3 doors with default entry fees
    console.log('📊 Seeding doors...');
    const { error: doorsError } = await supabase.from('doors').upsert([
      { id: 1, status: 'active', prize: 1000, entry_fee: 500 },
      { id: 2, status: 'active', prize: 2000, entry_fee: 750 },
      { id: 3, status: 'active', prize: 5000, entry_fee: 1000 },
    ], { onConflict: 'id' });

    if (doorsError) {
      console.error('❌ Error seeding doors:', doorsError);
    } else {
      console.log('✅ Doors seeded successfully');
    }

    // 2. Seed questions (1 per door)
    console.log('❓ Seeding questions...');
    
    const questions = [
      {
        door_id: 1,
        text: 'What is the capital of Nigeria?',
        format: 'multiple_choice',
        difficulty: 'easy',
        prize: 1000,
        time_limit: 10,
        options: ['Lagos', 'Abuja', 'Port Harcourt', 'Kano'],
        correct_answer: 'Abuja',
        case_sensitive: false,
        spelling_tolerance: 'strict',
        status: 'active',
      },
      {
        door_id: 2,
        text: 'Who was the first President of Nigeria?',
        format: 'multiple_choice',
        difficulty: 'medium',
        prize: 2000,
        time_limit: 15,
        options: ['Nnamdi Azikiwe', 'Obafemi Awolowo', 'Ahmadu Bello', 'Tafawa Balewa'],
        correct_answer: 'Nnamdi Azikiwe',
        case_sensitive: false,
        spelling_tolerance: 'strict',
        status: 'active',
      },
      {
        door_id: 3,
        text: 'What year did Nigeria gain independence?',
        format: 'type_answer',
        difficulty: 'hard',
        prize: 5000,
        time_limit: 20,
        options: null,
        correct_answer: '1960',
        case_sensitive: false,
        spelling_tolerance: 'strict',
        status: 'active',
      },
    ];

    const { data: insertedQuestions, error: questionsError } = await supabase
      .from('questions')
      .insert(questions)
      .select();

    if (questionsError) {
      console.error('❌ Error seeding questions:', questionsError);
    } else {
      console.log(`✅ ${insertedQuestions.length} questions seeded successfully`);

      // 3. Update doors with question_id
      console.log('🔗 Linking questions to doors...');
      for (let i = 0; i < insertedQuestions.length; i++) {
        const question = insertedQuestions[i];
        await supabase
          .from('doors')
          .update({ question_id: question.id })
          .eq('id', question.door_id);
      }
      console.log('✅ Questions linked to doors');
    }

    // 4. Seed default admin
    console.log('👤 Seeding default admin...');
    const adminEmail = 'admin@bitlyfe.com';
    const adminPassword = 'admin123';
    const hashedPassword = await bcrypt.hash(adminPassword, 10);

    const { error: adminError } = await supabase
      .from('admins')
      .upsert([{ email: adminEmail, password_hash: hashedPassword }], { onConflict: 'email' });

    if (adminError) {
      console.error('❌ Error seeding admin:', adminError);
    } else {
      console.log(`✅ Admin created: ${adminEmail} / ${adminPassword}`);
    }

    // 5. Seed app_settings
    console.log('⚙️  Seeding app settings...');
    const { error: settingsError } = await supabase.from('app_settings').upsert([
      {
        id: 1,
        entry_fee: 500,
        min_withdrawal: 1000,
        max_daily_plays: 20,
        new_user_bonus: 0,
        auto_rotate: false,
        auto_rotate_interval: 30,
        auto_approve_withdrawals: false,
        auto_approve_limit: 1000,
        game_name: 'BitLyfe',
        primary_color: '#00FF66',
        game_kill_switch: false,
      },
    ], { onConflict: 'id' });

    if (settingsError) {
      console.error('❌ Error seeding app settings:', settingsError);
    } else {
      console.log('✅ App settings seeded successfully');
    }

    // 6. Seed site content (terms of service)
    console.log('📄 Seeding terms of service...');
    const { error: termsError } = await supabase.from('site_content').upsert([
      {
        key: 'terms',
        content: `Welcome to BitLyfe! By using our platform, you agree to the following terms and conditions:

1. ELIGIBILITY: You must be at least 18 years old to use BitLyfe.

2. ACCOUNT SECURITY: You are responsible for maintaining the security of your account credentials.

3. GAME RULES: All game outcomes are final. BitLyfe reserves the right to void fraudulent plays.

4. WALLET & PAYMENTS: Deposits and withdrawals are processed through Paystack. Minimum withdrawal is ₦1,000.

5. FAIR PLAY: Any attempt to cheat, exploit bugs, or manipulate the system will result in account suspension and forfeiture of funds.

6. PRIVACY: We collect and store your phone number and transaction history. We do not share your data with third parties without consent.

7. REFUNDS: Entry fees for completed games are non-refundable.

8. SERVICE AVAILABILITY: BitLyfe may be temporarily unavailable for maintenance. We are not liable for losses due to downtime.

9. MODIFICATIONS: We reserve the right to modify these terms at any time. Continued use constitutes acceptance.

10. CONTACT: For support, contact us at support@bitlyfe.com.

Last updated: ${new Date().toISOString().split('T')[0]}`,
      },
    ], { onConflict: 'key' });

    if (termsError) {
      console.error('❌ Error seeding terms:', termsError);
    } else {
      console.log('✅ Terms of service seeded successfully');
    }

    console.log('\n🎉 Database seed completed successfully!');
    console.log('\n📋 Summary:');
    console.log('   - 3 Doors created (Entry fees: ₦500, ₦750, ₦1000)');
    console.log('   - 3 Questions created (Easy MC, Medium MC, Hard Type Answer)');
    console.log('   - Admin account: admin@bitlyfe.com / admin123');
    console.log('   - App settings initialized');
    console.log('   - Terms of service added');
    console.log('\n⚠️  Remember to change the admin password in production!');

  } catch (err) {
    console.error('❌ Seed failed:', err);
    process.exit(1);
  }

  process.exit(0);
}

seed();
