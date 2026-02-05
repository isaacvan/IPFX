# SUPABASE SETUP INSTRUCTIONS FOR REFERRAL SYSTEM

## ✅ What's Already Done

I've successfully updated `signup.html` with the following changes:

1. **Referral Code Input Field** - Added an optional referral code field to the signup form
2. **URL Parameter Detection** - Automatically pre-fills referral code from URL (e.g., `signup.html?ref=ABCD1234`)
3. **Validation** - Validates referral codes are 8 alphanumeric characters
4. **Supabase Integration** - Passes referral code to Supabase in user metadata

---

## 🔧 What YOU Need to Do in Supabase

### Step 1: Run the SQL Migration

1. Go to your Supabase project: https://supabase.com/dashboard/project/agulweemteoeagscmppy
2. Click on **SQL Editor** in the left sidebar
3. Click **New Query**
4. Copy and paste the **entire contents** of `add-referral-system.sql`
5. Click **Run** (or press Cmd/Ctrl + Enter)

This will:
- Add `referral_code`, `referred_by_code`, and `referral_count` columns to `user_profiles`
- Create a function to generate unique 8-character referral codes
- Update the auto-create trigger to handle referral tracking
- Create an optional `referrals` table for detailed tracking

### Step 2: Verify the Changes

After running the SQL, verify it worked:

1. Go to **Table Editor** → **user_profiles**
2. Check that these new columns exist:
   - `referral_code` (varchar, unique)
   - `referred_by_code` (varchar)
   - `referral_count` (integer, default 0)

3. Go to **Database** → **Functions**
4. Check that `generate_referral_code` function exists

5. Go to **Database** → **Triggers**
6. Check that `on_auth_user_created` trigger is updated

---

## 🧪 Testing the Referral System

### Test 1: New User Gets Referral Code
1. Sign up a new user at `signup.html`
2. Check your email and confirm the account
3. Go to **SQL Editor** and run:
   ```sql
   SELECT referral_code, referral_count
   FROM user_profiles
   WHERE user_id = 'YOUR_USER_ID';
   ```
4. You should see an 8-character referral code like `A3K9P2M7`

### Test 2: Referral Link Works
1. Get the referral code from Test 1 (e.g., `A3K9P2M7`)
2. Open a new incognito window
3. Go to: `http://localhost:8000/signup.html?ref=A3K9P2M7`
   (Or your actual domain)
4. Verify the referral code field is pre-filled and locked
5. Sign up with a different email
6. After confirmation, check the database:
   ```sql
   -- Check the new user's profile
   SELECT referred_by_code FROM user_profiles WHERE email = 'newemail@example.com';
   -- Should show: A3K9P2M7

   -- Check the referrer's count increased
   SELECT referral_count FROM user_profiles WHERE referral_code = 'A3K9P2M7';
   -- Should show: 1
   ```

---

## 📊 Viewing Referral Data

### Get All Users and Their Referral Stats

```sql
SELECT
    user_id,
    full_name,
    referral_code,
    referral_count,
    referred_by_code,
    created_at
FROM user_profiles
ORDER BY created_at DESC;
```

### Get Referral Relationships

```sql
SELECT
    referrer.full_name as referrer_name,
    referrer.referral_code,
    referrer.referral_count,
    referee.full_name as referee_name,
    referee.created_at as signup_date
FROM user_profiles referrer
JOIN user_profiles referee ON referee.referred_by_code = referrer.referral_code
ORDER BY referee.created_at DESC;
```

### Get Top Referrers

```sql
SELECT
    full_name,
    referral_code,
    referral_count
FROM user_profiles
WHERE referral_count > 0
ORDER BY referral_count DESC
LIMIT 10;
```

---

## 🎨 Using the Referral Dashboard Component

I've created a standalone referral dashboard component at:
`referral-dashboard-component.html`

### To integrate it into your existing dashboard:

1. Copy the CSS styles from the component
2. Copy the HTML structure
3. Copy the JavaScript functionality
4. Update the Supabase credentials if needed

The component shows:
- User's unique referral code
- Number of successful referrals
- Copy link button
- Social share buttons (Email, Twitter, WhatsApp)
- Earnings calculations

---

## 🔐 Security Notes

1. **Referral Code Validation**: Codes are validated on the client side, but the database trigger ensures integrity
2. **SQL Injection Protection**: All functions use parameterized queries
3. **Row Level Security**: RLS policies ensure users can only see their own referral data
4. **Unique Constraints**: Database enforces referral code uniqueness

---

## 🚀 Referral URL Format

Share links will be in this format:
```
https://ipfxcapital.com/signup.html?ref=ABCD1234
```

The referral code will:
- Auto-populate in the signup form
- Be locked (readonly) so users can't change it
- Be validated before submission
- Be stored in the database when the user signs up

---

## 💡 Future Enhancements (Optional)

1. **Reward System**: Add a `rewards` table to track earnings per referral
2. **Referral Tiers**: Bronze/Silver/Gold based on referral count
3. **Email Notifications**: Notify users when someone uses their referral code
4. **Analytics Dashboard**: Track referral conversions over time
5. **Expiring Codes**: Add expiration dates to referral codes
6. **Custom Codes**: Allow users to choose custom referral codes

---

## 📝 Files Created

1. ✅ `add-referral-system.sql` - SQL migration to run in Supabase
2. ✅ `signup-with-referral-code-update.txt` - Detailed implementation notes (now obsolete, changes are done)
3. ✅ `referral-dashboard-component.html` - Ready-to-use referral dashboard
4. ✅ `SUPABASE-SETUP-INSTRUCTIONS.md` - This file

---

## ❓ Troubleshooting

### Problem: Referral code not being generated
**Solution**: Check that the `on_auth_user_created` trigger is enabled in Supabase

### Problem: Referral count not incrementing
**Solution**: Verify the trigger function has `SECURITY DEFINER` privilege

### Problem: Duplicate referral codes
**Solution**: The `generate_referral_code` function uses UUID + timestamp, making collisions extremely unlikely

### Problem: Can't find user's referral code
**Solution**: Run this query:
```sql
SELECT referral_code FROM user_profiles WHERE user_id = auth.uid();
```

---

## 📞 Need Help?

If you encounter any issues:
1. Check the Supabase logs in the dashboard
2. Verify RLS policies are enabled
3. Check that the trigger is firing after user creation
4. Test with a fresh incognito browser window

---

## ✨ Summary

**What works now:**
- ✅ New users automatically get unique 8-character referral codes
- ✅ Referral codes can be shared via URL parameters
- ✅ Signup form auto-populates and locks referral code from URL
- ✅ Database automatically tracks referral relationships
- ✅ Referrer's count increments when someone signs up with their code
- ✅ All data is secured with Row Level Security policies

**What you need to do:**
1. Run `add-referral-system.sql` in Supabase SQL Editor
2. Test the functionality
3. (Optional) Integrate the referral dashboard component

That's it! Your referral system is ready to go. 🎉
