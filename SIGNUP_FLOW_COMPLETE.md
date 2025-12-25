# 📝 Complete Signup Flow - Easy Guide

> **Note:** This document explains the **actual implemented backend logic** for the signup flow, mapping each frontend API call to what happens in the database.

---

## 🎯 Overview

The user signup journey consists of **2 main steps** (not 4 as mentioned in frontend):
1. **Email/Password Registration** - Creates account
2. **Personal/Professional Information** - Updates user profile

⚠️ **Important:** Email verification is **NOT implemented** in the backend yet. The `email_verified` field exists in the database but no verification endpoint or logic is present.

---

## 📊 Step-by-Step Flow with Database Changes

### **Step 1: User Registration**

#### 🔗 API Endpoint
```
POST /auth/register
```

#### 📥 Request Body
```json
{
  "email": "user@example.com",
  "username": "johndoe",
  "password": "SecurePassword123!"
}
```

#### 🎯 What Happens in Backend

**File:** `auth.service.ts` → `register()` method (lines 39-86)

**Process:**
1. **Validates** request data using `RegisterDto`:
   - Email must be valid format
   - Username must be at least 3 characters
   - Password must be at least 8 characters

2. **Checks for existing user**:
   ```typescript
   prisma.users.findFirst({
     where: { OR: [{ email }, { username }] }
   })
   ```
   - If email exists → throws `ConflictException: "Email already registered"`
   - If username exists → throws `ConflictException: "Username already taken"`

3. **Hashes password** using bcrypt (10 rounds):
   ```typescript
   const passwordHash = await bcrypt.hash(password, 10);
   ```

4. **Generates 2FA secret** for future use:
   ```typescript
   const twoFactorSecret = twoFactorService.generateTOTPSecret();
   ```

5. **Creates user in database**:
   ```typescript
   prisma.users.create({
     data: {
       email,
       username,
       password_hash: passwordHash,
       two_factor_enabled: true,
       two_factor_secret: twoFactorSecret,
     }
   })
   ```

#### 🗄️ Database Changes

**Table:** `users`

| Field | Value | Notes |
|-------|-------|-------|
| `user_id` | UUID (auto-generated) | Primary key |
| `email` | user@example.com | Unique |
| `username` | johndoe | Unique |
| `password_hash` | $2b$10$... | bcrypt hash (60 chars) |
| `email_verified` | **false** | Default value |
| `kyc_status` | **pending** | Default value |
| `two_factor_enabled` | **true** | Always enabled |
| `two_factor_secret` | base32 string | 32-char secret |
| `full_name` | NULL | Not set yet |
| `dob` | NULL | Not set yet |
| `nationality` | NULL | Not set yet |
| `gender` | NULL | Optional |
| `phone_number` | NULL | Optional |
| `profile_pic_url` | NULL | Not set yet |
| `created_at` | 2025-12-25 10:30:00 | Auto timestamp |
| `updated_at` | NULL | Updates on change |

#### 📤 Response
```json
{
  "user": {
    "user_id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "username": "johndoe",
    "email_verified": false,
    "kyc_status": "pending"
  },
  "message": "User registered successfully. 2FA is enabled."
}
```

#### ❗ Why This Works
- User account is **created immediately** in the database
- **No tokens** are returned (user needs to login separately)
- **No email is sent** (email verification not implemented)
- User can proceed to login with email/username + password

---

### **Step 2: Email Verification** ⚠️ NOT IMPLEMENTED

#### 🔗 Expected API Endpoint
```
GET /auth/verify-email?token={verificationToken}
```

#### ❌ Current Status
**This endpoint DOES NOT EXIST** in the backend.

#### 🗄️ What Should Happen (but doesn't)
1. Generate verification token after registration
2. Send email with verification link
3. User clicks link
4. Backend validates token and sets `email_verified = true`

#### 🔄 Current Workaround
- Users can use the system without email verification
- `email_verified` field remains `false` in the database
- No functionality currently checks this field

---

### **Step 3: Login with Email/Password**

#### 🔗 API Endpoint
```
POST /auth/login
```

#### 📥 Request Body
```json
{
  "emailOrUsername": "user@example.com",
  "password": "SecurePassword123!"
}
```

#### 🎯 What Happens in Backend

**File:** `auth.service.ts` → `login()` method (lines 88-135)

**Process:**
1. **Rate limiting check** (if IP provided):
   ```typescript
   rateLimitService.checkRateLimit(ipAddress);
   ```

2. **Finds user by email OR username**:
   ```typescript
   prisma.users.findFirst({
     where: { OR: [{ email }, { username }] }
   })
   ```

3. **Verifies password** using bcrypt:
   ```typescript
   const isValid = await bcrypt.compare(password, user.password_hash);
   ```
   - If invalid → records failed attempt → throws `UnauthorizedException`

4. **Generates 6-digit 2FA code**:
   ```typescript
   const code = await twoFactorService.generateCode(user.user_id, 'login');
   ```

5. **Sends code via email** (SendGrid):
   ```typescript
   await twoFactorService.sendCodeByEmail(user.email, code);
   ```

#### 🗄️ Database Changes

**Table:** `two_factor_codes`

| Field | Value | Notes |
|-------|-------|-------|
| `code_id` | UUID (auto-generated) | Primary key |
| `user_id` | 550e8400-e29b-... | Foreign key to users |
| `code` | "123456" | 6-digit random number |
| `expires_at` | 2025-12-25 10:40:00 | 10 minutes from now |
| `used` | **false** | Not used yet |
| `purpose` | "login" | Purpose identifier |
| `created_at` | 2025-12-25 10:30:00 | Auto timestamp |

#### 📤 Response
```json
{
  "requires2FA": true,
  "message": "2FA code sent to your email"
}
```

#### ❗ Why This Works
- **No tokens yet** - user must verify 2FA code first
- Code is emailed using SendGrid
- Frontend should redirect to 2FA code entry screen

---

### **Step 4: Verify 2FA Code**

#### 🔗 API Endpoint
```
POST /auth/verify-2fa
```

#### 📥 Request Body
```json
{
  "emailOrUsername": "user@example.com",
  "code": "123456"
}
```

#### 🎯 What Happens in Backend

**File:** `auth.service.ts` → `verify2FA()` method (lines 138-206)

**Process:**
1. **Finds user by email/username**

2. **Validates 2FA code**:
   ```typescript
   prisma.two_factor_codes.findFirst({
     where: {
       user_id: userId,
       code: "123456",
       purpose: "login",
       used: false,
       expires_at: { gt: new Date() } // Not expired
     }
   })
   ```

3. **Marks code as used**:
   ```typescript
   prisma.two_factor_codes.update({
     data: { used: true }
   })
   ```

4. **Generates JWT tokens**:
   ```typescript
   // Refresh Token (7 days)
   const refreshToken = await tokenService.generateRefreshToken({
     sub: user.user_id,
     email: user.email,
     username: user.username
   });
   
   // Access Token (15 minutes)
   const accessToken = await tokenService.generateAccessToken(payload);
   ```

5. **Creates session in database**:
   ```typescript
   sessionService.createSession(user_id, refreshToken, ipAddress, deviceId);
   ```

#### 🗄️ Database Changes

**Table:** `user_sessions`

| Field | Value | Notes |
|-------|-------|-------|
| `session_id` | UUID (auto-generated) | Primary key |
| `user_id` | 550e8400-e29b-... | Foreign key to users |
| `issued_at` | 2025-12-25 10:30:00 | Auto timestamp |
| `expires_at` | 2026-01-01 10:30:00 | 7 days from now |
| `revoked` | **false** | Active session |
| `refresh_token_hash` | $2b$10$... | Hashed refresh token |
| `ip_address` | 192.168.1.100 | User's IP |
| `device_id` | mobile-app-001 | Optional device ID |

**Table:** `two_factor_codes` (update)

| Field | Value | Notes |
|-------|-------|-------|
| `used` | **true** | Code marked as used |

#### 📤 Response
```json
{
  "user": {
    "user_id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "username": "johndoe",
    "email_verified": false,
    "kyc_status": "pending"
  },
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "sessionId": "650e8400-e29b-41d4-a716-446655440000"
}
```

#### 🍪 Cookies Set
- `access_token` - expires in 45 minutes
- `refresh_token` - expires in 7 days

#### ❗ Why This Works
- Tokens stored in **HTTP-only cookies** (secure)
- Also returned in response body (fallback for mobile/cross-origin)
- Session tracked in database for security
- User is now **fully authenticated**

---

### **Step 5: Get User Profile**

#### 🔗 API Endpoint
```
GET /users/me
```

#### 🔒 Authorization Required
- Bearer token in `Authorization: Bearer {accessToken}` header
- OR `access_token` cookie

#### 🎯 What Happens in Backend

**File:** `users.controller.ts` → `getCurrentUser()` (lines 20-24)
**File:** `users.service.ts` → `getCurrentUserProfile()` (lines 58-72)

**Process:**
1. **JWT Guard validates token** and extracts `user_id`

2. **Fetches user from database**:
   ```typescript
   prisma.users.findUnique({
     where: { user_id },
     select: {
       user_id, email, username, full_name, phone_number,
       dob, nationality, gender, kyc_status, profile_pic_url
     }
   })
   ```

#### 🗄️ Database Query
No changes, just **reads** from `users` table.

#### 📤 Response
```json
{
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "email": "user@example.com",
  "username": "johndoe",
  "full_name": null,
  "phone_number": null,
  "dob": null,
  "nationality": null,
  "gender": null,
  "kyc_status": "pending",
  "profile_pic_url": null
}
```

---

### **Step 6: Update Personal Information (Onboarding Step 1)**

#### 🔗 API Endpoint
```
PATCH /users/me/personal-info
```

#### 🔒 Authorization Required
Yes - JWT token required

#### 📥 Request Body
```json
{
  "fullName": "John Doe",
  "dob": "1995-05-15",
  "nationality": "United States",
  "gender": "male",
  "phoneNumber": "+14155552671"
}
```

#### 🎯 What Happens in Backend

**File:** `users.controller.ts` → `updateCurrentUserPersonalInfo()` (lines 26-33)
**File:** `users.service.ts` → `updatePersonalInfo()` (lines 74-100)

**Process:**
1. **Validates** request data using `UpdatePersonalInfoDto`:
   - `fullName`: 2-120 characters (required)
   - `dob`: Valid date string (required)
   - `nationality`: 2+ characters (required)
   - `gender`: enum (male/female/other/prefer-not-to-say) - optional
   - `phoneNumber`: International format (+1234567890) - optional

2. **Converts date string to Date object**:
   ```typescript
   const dobDate = new Date(data.dob);
   ```

3. **Updates user in database**:
   ```typescript
   prisma.users.update({
     where: { user_id },
     data: {
       full_name: "John Doe",
       dob: Date("1995-05-15"),
       nationality: "United States",
       gender: "male",
       phone_number: "+14155552671"
     }
   })
   ```

#### 🗄️ Database Changes

**Table:** `users` (update)

| Field | Before | After | Notes |
|-------|--------|-------|-------|
| `full_name` | NULL | "John Doe" | Updated |
| `dob` | NULL | 1995-05-15 | Updated |
| `nationality` | NULL | "United States" | Updated |
| `gender` | NULL | "male" | Updated |
| `phone_number` | NULL | "+14155552671" | Updated |
| `updated_at` | NULL | 2025-12-25 10:35:00 | Auto timestamp |

#### 📤 Response
```json
{
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "email": "user@example.com",
  "username": "johndoe",
  "full_name": "John Doe",
  "dob": "1995-05-15T00:00:00.000Z",
  "nationality": "United States",
  "gender": "male",
  "phone_number": "+14155552671",
  "created_at": "2025-12-25T10:30:00.000Z",
  "updated_at": "2025-12-25T10:35:00.000Z"
}
```

---

### **Step 7: Update Professional Information (Onboarding Step 2)** ⚠️ NOT IMPLEMENTED

#### 🔗 Expected API Endpoint
```
PUT /users/profile
```

#### ❌ Current Status
The backend **does NOT have professional information fields** in the database schema.

#### 🗄️ Missing Fields in `users` table:
- `job_title`
- `company`
- `industry`
- `years_of_experience`

#### 🔄 Current Workaround
- Frontend may be calling the same personal info endpoint again
- Or this step is **skipped entirely** in the backend
- **Professional info is NOT stored** anywhere

---

## 🔄 Additional APIs Used During Signup

### **POST /auth/refresh** - Refresh Access Token

#### 🔗 API Endpoint
```
POST /auth/refresh
```

#### 🔒 Authorization Required
- Requires `refresh_token` cookie

#### 🎯 What Happens in Backend

**File:** `auth.service.ts` → `refresh()` (lines 200-259)

**Process:**
1. **Cleans up expired sessions**

2. **Finds session by refresh token**:
   ```typescript
   sessionService.findSessionByRefreshToken(refreshToken);
   ```
   - Validates token hash
   - Checks if session is revoked or expired

3. **Generates NEW tokens**:
   ```typescript
   const newRefreshToken = await tokenService.generateRefreshToken();
   const newAccessToken = await tokenService.generateAccessToken();
   ```

4. **Updates session with new refresh token** (token rotation):
   ```typescript
   sessionService.updateSessionRefreshToken(sessionId, newRefreshToken);
   ```

5. **Extends session expiry** by 7 days:
   ```typescript
   prisma.user_sessions.update({
     data: { expires_at: new Date(+7 days) }
   });
   ```

#### 🗄️ Database Changes

**Table:** `user_sessions` (update)

| Field | Before | After | Notes |
|-------|--------|-------|-------|
| `refresh_token_hash` | $2b$10$oldtoken... | $2b$10$newtoken... | Token rotated |
| `expires_at` | 2026-01-01 10:30:00 | 2026-01-08 10:30:00 | Extended 7 days |

#### 📤 Response
```json
{
  "message": "Tokens refreshed successfully"
}
```

#### 🍪 Cookies Updated
- `access_token` - new token, expires in 45 minutes
- `refresh_token` - new token, expires in 7 days

---

### **POST /auth/resend-verification** ⚠️ NOT IMPLEMENTED

This endpoint **does NOT exist** in the backend.

---

## 📋 Complete User Journey Summary

### ✅ What Actually Happens (Current Implementation)

```
1. Frontend: Sign Up Page
   ↓
2. API Call: POST /auth/register
   ↓
3. Database: INSERT into users table
   ├─ user_id: UUID
   ├─ email: user@example.com
   ├─ username: johndoe
   ├─ password_hash: $2b$10$...
   ├─ email_verified: FALSE ❌ (not verified)
   ├─ kyc_status: pending
   ├─ two_factor_enabled: TRUE
   └─ two_factor_secret: base32 string
   ↓
4. Response: User object (no tokens)
   ↓
5. Frontend: Login Page (user must login separately)
   ↓
6. API Call: POST /auth/login
   ↓
7. Database: INSERT into two_factor_codes table
   ├─ code: "123456" (random 6 digits)
   ├─ expires_at: +10 minutes
   └─ purpose: "login"
   ↓
8. Email Sent: 2FA code via SendGrid
   ↓
9. Frontend: Enter 2FA Code Page
   ↓
10. API Call: POST /auth/verify-2fa
    ↓
11. Database Changes:
    ├─ UPDATE two_factor_codes SET used = TRUE
    └─ INSERT into user_sessions table
       ├─ session_id: UUID
       ├─ refresh_token_hash: $2b$10$...
       ├─ expires_at: +7 days
       └─ ip_address, device_id
    ↓
12. Response: Tokens + User object
    ├─ accessToken (15 min)
    ├─ refreshToken (7 days)
    └─ sessionId
    ↓
13. Cookies Set: access_token, refresh_token
    ↓
14. Frontend: Onboarding Step 1 (Personal Info)
    ↓
15. API Call: PATCH /users/me/personal-info
    ↓
16. Database: UPDATE users table
    ├─ full_name: "John Doe"
    ├─ dob: 1995-05-15
    ├─ nationality: "United States"
    ├─ gender: "male"
    ├─ phone_number: "+14155552671"
    └─ updated_at: current timestamp
    ↓
17. Frontend: Onboarding Step 2 (Professional Info) ❌ NO BACKEND SUPPORT
    ↓
18. Frontend: Dashboard → User fully registered! 🎉
```

---

## ⚠️ Critical Gaps in Implementation

### 1️⃣ Email Verification Missing
- **Status:** NOT IMPLEMENTED
- **Impact:** Users can sign up without verifying email
- **Database Field:** `email_verified` always remains `false`
- **Required Implementation:**
  - Generate verification token after registration
  - Send verification email with link
  - Create `GET /auth/verify-email?token=xxx` endpoint
  - Update `email_verified = true` when verified

### 2️⃣ Professional Information Missing
- **Status:** NOT IMPLEMENTED
- **Impact:** Frontend step 2 has nowhere to store data
- **Missing Fields:** job_title, company, industry, years_of_experience
- **Required Implementation:**
  - Add fields to `users` table via Prisma migration
  - Update `UpdatePersonalInfoDto` or create new DTO
  - Modify `updatePersonalInfo()` method to handle new fields

### 3️⃣ Resend Verification Missing
- **Status:** NOT IMPLEMENTED
- **Impact:** If user doesn't receive email, can't resend
- **Required Implementation:**
  - Create `POST /auth/resend-verification` endpoint
  - Generate new token
  - Send email again

---

## 🔐 Security Features Implemented

✅ **Password Hashing** - bcrypt with 10 salt rounds  
✅ **2FA Enabled** - Always enabled for all users  
✅ **JWT Tokens** - Access (15min) + Refresh (7 days)  
✅ **Token Rotation** - Refresh tokens rotated on each refresh  
✅ **Session Management** - Stored in database with expiry tracking  
✅ **Rate Limiting** - Protects against brute force attacks  
✅ **HTTP-Only Cookies** - Secure token storage  
✅ **IP Tracking** - Records user IP in sessions  
✅ **Device Tracking** - Optional device ID tracking  

---

## 📊 Database Tables Used

### 1. `users`
- **Purpose:** Store user accounts and profile data
- **Created:** During registration (Step 1)
- **Updated:** During profile updates (Step 3)
- **Key Fields:** email, username, password_hash, full_name, dob, nationality, gender, phone_number

### 2. `two_factor_codes`
- **Purpose:** Store 2FA verification codes
- **Created:** During login (Step 2)
- **Updated:** Marked as `used` after verification (Step 4)
- **Key Fields:** code, expires_at, used, purpose

### 3. `user_sessions`
- **Purpose:** Track user login sessions
- **Created:** After 2FA verification (Step 4)
- **Updated:** During token refresh
- **Key Fields:** session_id, refresh_token_hash, expires_at, revoked, ip_address

---

## 🎯 Conclusion

The signup flow is **partially implemented**:
- ✅ Registration works
- ✅ Login with 2FA works
- ✅ Personal info update works
- ✅ Token refresh works
- ❌ Email verification NOT implemented
- ❌ Professional info NOT implemented
- ❌ Resend verification NOT implemented

**Frontend vs Backend Mismatch:**
- Frontend assumes 4 steps
- Backend only supports 2 steps
- Email verification flow exists in frontend but not backend

**Next Steps for Full Implementation:**
1. Add email verification system
2. Add professional info fields to database
3. Create resend verification endpoint
4. Update frontend to match actual backend flow
