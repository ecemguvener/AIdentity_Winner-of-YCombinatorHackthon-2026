# 2FA Signup Flow

1. Use `barkan_whoami` to get the agent email address and phone number.
2. Create the account with the agent email or phone number.
3. Call `barkan_sms_latest_code` with `since_minutes: 10`.
4. Use the returned code once.
5. If no code appears, ask the user whether to wait and retry.

Never invent a verification code. If Barkan returns `not_found`, say no recent code was found.
