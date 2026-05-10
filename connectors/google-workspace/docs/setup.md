# Google Workspace Connector Setup

## 1. Instalar o gws CLI

```bash
npm install -g @googleworkspace/cli
```

## 2. Autenticar

```bash
gws auth login          # OAuth interativo
# ou
gws auth setup          # cria projeto GCP, habilita APIs e faz login automaticamente
```

## 3. Exportar credenciais

```bash
gws auth export --unmasked > ~/.gates/google-credentials.json
export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=~/.gates/google-credentials.json
```

## Ferramentas disponíveis

### gws_calendar
```
gws_calendar args="calendar +agenda --week"
gws_calendar args="calendar +agenda --today"
gws_calendar args="calendar events list --params '{\"calendarId\":\"primary\"}'"
```

### gws_meet
```
gws_meet args="meet conferenceRecords list"
gws_meet args="meet conferenceRecords transcripts list --params '{\"parent\":\"conferenceRecords/ID\"}'"
gws_meet args="meet conferenceRecords transcripts entries list --params '{\"parent\":\"conferenceRecords/ID/transcripts/ID\"}'"
gws_meet args="meet conferenceRecords participants list --params '{\"parent\":\"conferenceRecords/ID\"}'"
```

### gws_drive
```
gws_drive args="drive files list --params '{\"q\":\"name contains transcript\"}'"
```
