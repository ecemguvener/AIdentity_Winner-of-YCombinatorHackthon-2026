# Phone Call Flow

1. Clarify date, time, party size, name, phone number, and hard constraints.
2. Call `barkan_phone_call` with a concrete task and concise context.
3. Do not pass `wait_for_approval` unless the user explicitly wants the call to block while they approve it.
4. Read final status with `barkan_phone_get_call`.
5. Summarize confirmed facts only. If not confirmed, say what is still unknown.

Never fabricate a transcript or claim a reservation exists before Barkan reports it.
