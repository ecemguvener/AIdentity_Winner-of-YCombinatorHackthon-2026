# Email Follow-up Flow

1. Send with `barkan_email_send`.
2. Later call `barkan_email_list_threads`.
3. Read the relevant thread with `barkan_email_read_thread`.
4. Draft the response from actual thread content.
5. Reply with `barkan_email_reply`.

For blocked recipients or approval denials, report the Barkan reason and stop.
