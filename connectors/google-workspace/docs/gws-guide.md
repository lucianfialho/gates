# Google Workspace CLI — How to Use

The `gws` CLI is already authenticated. Use it via the `bash` tool.

## Meetings

```bash
# List recent meetings
bash: gws meet conferenceRecords list

# More results
bash: gws meet conferenceRecords list --params '{"pageSize": 50}'
```

Response: `{"conferenceRecords": [{"name": "conferenceRecords/ID", "startTime": "...", "endTime": "..."}]}`

## Transcripts

```bash
# Step 1 — get transcript ID for a meeting
bash: gws meet conferenceRecords transcripts list --params '{"parent": "conferenceRecords/RECORD_ID"}'

# Step 2 — get all spoken text (always use --page-all)
bash: gws meet conferenceRecords transcripts entries list \
  --params '{"parent": "conferenceRecords/RECORD_ID/transcripts/TRANSCRIPT_ID"}' \
  --page-all
```

Response entries: `{"transcriptEntries": [{"text": "spoken words", "startTime": "...", "participant": "..."}]}`

Only use transcripts with `"state": "APPLIED"`.

## Participants

```bash
bash: gws meet conferenceRecords participants list --params '{"parent": "conferenceRecords/RECORD_ID"}'
```

## Calendar

```bash
bash: gws calendar +agenda --week
bash: gws calendar events list --params '{"calendarId": "primary", "q": "Q&A"}'
```

## Getting Transcripts from Google Drive (fallback)

When Meet API transcript is empty (`{}` or no entries), Google saved it as a Google Doc in Drive instead.

**Automatic fallback — do this without asking the user:**

```bash
# 1. Search Drive for the transcript doc by meeting name
bash: gws drive files list --params '{"q":"name contains \"MEETING_NAME\" and mimeType=\"application/vnd.google-apps.document\"","pageSize":5}'

# Or search broadly for recent transcript docs
bash: gws drive files list --params '{"q":"(name contains \"transcrição\" or name contains \"transcript\" or name contains \"notas\") and mimeType=\"application/vnd.google-apps.document\"","orderBy":"modifiedTime desc","pageSize":10}'

# 2. Export the found document as plain text
bash: gws drive files export --params '{"fileId":"FOUND_DOC_ID","mimeType":"text/plain"}'
```

**Full pipeline when transcript API is empty:**
1. `gws meet conferenceRecords list` → find meeting ID and name
2. Meet transcript API returns `{}` → go to Drive fallback
3. `gws drive files list` searching by meeting name → find the doc ID
4. `gws drive files export` → read the full transcript text
5. Analyze and present results

NEVER ask the user for the transcript link — find it in Drive yourself.

## Correct behavior examples

When user asks: "puxa as reuniões de sexta com meu time"
→ IMMEDIATELY run: `gws meet conferenceRecords list`
→ Filter by startTime for Friday dates
→ Present results

When user asks: "pega a transcrição do Q&A"
→ Run: `gws meet conferenceRecords list` to find the meeting
→ Run: `gws meet conferenceRecords transcripts list` to get transcript ID
→ Run: `gws meet conferenceRecords transcripts entries list --page-all`
→ Present the transcript text

NEVER say "não tenho acesso" or "OAuth required" — gws is already configured.
