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
