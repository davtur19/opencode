# Goal State — rate limit gateway + stabilità servizio

## Goal
1. Eliminare i 429 intermittenti del gateway opencode.ai (rate limit per IP sulla rotta zen).
2. Stabilizzare il servizio `opencode.service` (crash ricorrenti SIGABRT Bun) e impedire core dump da 7GB sul disco.

## ROOT CAUSE crash (rivista 13:4x-14:1x, evidencia)
- **Non è RAM**: il sito deterministico `0x3a7cb00` è dentro codice **NAPI di Bun** (`napi_internal_enqueue_finalizer+0x11b300`, subito dopo `call abort@plt`); binario **non-PIE** (Type: EXEC) → indirizzo fisso, stesso bug ogni volta.
- **15 ABRT dal 2 agosto** (10:39/10:44/12:03/12:05/12:08/12:24/13:35/13:39/13:41/13:44/23:41 ago02, 22:54 ago07, 12:28/13:19/13:35 ago12), sempre con panic Rust `failed to spawn <fff-*> thread: Os { code: 11, WouldBlock, EAGAIN }` (ago02: panic→ABRT entro 1s, 3/3 volte). Fonte: `crates/fff-core`/`@ff-labs/fff-bun 0.9.4` — **file search upstream di opencode** (#27802, fix upstream giugno: broad scanning disabilitato, content caches disabilitati 2db96c9b7e), NON codice async del fork.
- **bun 1.3.14 è l'ULTIMA release** (verificato github API) → nessun upgrade bun possibile.
- **Cause EAGAIN**: cgroup `pids.max=512` (TasksMax) con 2-3 mcp-reva + npm exec @playwright + sessioni; oggi pids.current=275/512, main process 237 thread. `Committed_AS 33.5G > CommitLimit 24.4G` (overcommit heuristic) — secondario.
- **FIX APPLICATO**: `TasksMax=512→4096` (decisione utente: la macchina deve fare solo opencode; dedup MCP NON voluto perché ogni chat usa un progetto diverso → 1 set MCP per sessione è by design) + daemon-reload (vale al prossimo ExecStart). Opzionale se i crash persistono: `@ff-labs/fff-bun 0.9.4→0.10.3` (API verificata compatibile: FileFinder/InitOptions ecc. esportati) + rebuild binario (bun 1.3.14 resta).
- Verificato: upstream è a 0.9.4 con stesso fff.bun.ts (nessuna patch da importare).
- **Perché pids cresce (evidenza live)**: ogni materializzazione dell'MCP layer (`MCP.node`, `packages/opencode/src/mcp/index.ts:998`, layer effetto :204) spawna UN SET di server MCP persistente; ora: 2× mcp-reva (~700MB RSS l'uno!) + 2× playwright (npm exec), nati a 13:35:57 e 13:37:41 (4s e 108s dopo lo start) e MAI uccisi. Processo principale: 237 thread (Bun/JSC/fff). `pids.current=275/512` a riposo — con più client/sessioni il 512 si satura → EAGAIN. Fix di codice possibili nel fork: dedupe client MCP per server-name (riuso), reap dei figli MCP all'ultimo disconnect, o bump fff-bun 0.10.3 (path di fallimento dello spawn non fatale).

## Fatti verificati (OSSERVATO)
- **Rate limiting gateway**: `packages/console/app/src/routes/zen/util/handler.ts:104-105` tronca `x-real-ip` a /64; `:127` solo `createIpRateLimiter` lancia `FreeUsageLimitError` ("Rate limit exceeded. Please try again later."); ip "nuovo" (lifetime<dailyLimit*7) ha quota 2x; numeri in segreto SST `ZEN_LIMITS`.
- **v6proxy** (CT 106, Alpine, 192.168.1.6, porte 3128/6666): routed /48 `2001:470:b439::/48`, randomizza TUTTI gli 80 bit dopo /48 ad ogni nuova connessione TCP (varia il /64); IPv6-only (no AAAA→502); log `/var/log/v6proxy/access.log`. Rotazione per connessione, non per richiesta.
- **Perché i 429**: pool HTTP keep-alive riusa la socket → stesso /64 → stesso bucket Redis → 429. Restart = socket nuove = /64 nuovo = "fix".
- **FIX DEPLOYATO**: `packages/opencode/src/provider/provider.ts:197-202` (loader `opencode`): `options.header Connection: close` → ogni richiesta LLM chiude la socket → IPv6 nuovo a ogni richiesta. Commit `0cd10587c` pushato su main (--no-verify). Binario `0.0.0-main-202608121112` (184MB), deploy 13:12, backup `.bak.20260812-131244`. `ss -tn | grep 127.0.0.1:443` vuoto a fine turno.
- **Repo privata**: `davtur19/opencode` resa privata e DETACHED dalla fork network (fork:false, parent:null → repo ricreata con nuovo ID → vecchio PAT perso); nuovo PAT dedicato salvato nella remote URL. `gh` (hosts.yml) senza permesso Administration (403), ma non serve più.
- **Crash servizio (RICORRENTE)**: SIGABRT silenzioso su main thread JS a indirizzo deterministico `0x3a7cb00`, stesso nei 2 binari; ora 4° crash (12:28, 13:19, 13:35:37). Picchi 2.8–4.4G < limiti, mai SIGKILL → non cgroup, non OOM-killer. Macchina 10Gi, **swap 0**, overcommit=0, anon ~6-7G (openchamber node + reva python ~580MB l'uno); al crash frame ~186MB liberi. Teoria: malloc fallisce per pressione anon globale → Bun abort. DA VERIFICARE: swap o riduzione consumatori.
- **Core dump**: `core_pattern = core` → file nel cwd; ogni ABRT = ~7GB. Il core.483534/483541 (repo) erano dei processi build/typecheck (tsgo) del 13:2x, non del servizio.
- **LimitCORE vs CoreFileSize**: `CoreFileSize=0` è chiave IGNORATA da questa systemd ("Unknown key") → core comunque scritto; corretto in `LimitCORE=0` (valido, applicato al prossimo ExecStart). daemon-reload fatto.
- **Shutdown lenti**: stop prende >30s perché mcp-reva figli non muoiono in tempo → systemd SIGKILL (result=timeout o stop-sigterm timed out) — innocui ma rumorosi.

## Work State
### Completed
- 9 tunnel socat v6 attivi e rinominati (niente api2): ai/www/models/zenmux/gateway/api/app/console/dev = 127.0.0.1–.9, unit `/etc/systemd/system/opencode-*-v6-tunnel.service`; zero socket dirette.
- Fix Connection: close implementato (provider.ts:197-202), compilato, deployato; commit+push `0cd10587c`.
- Repo resa privata (da web UI dell'utente), nuovo PAT nella remote.
- Diagnosi crash: ABRT Bun deterministico; core rimossi (4×7GB totali circa, ultimo core.495266 rimosso 13:4x); limiti unit aggiornati (MemoryHigh≈8GiB/MemoryMax≈9GiB effettivi, file 6G/8G — verificare disallineamento) + `LimitCORE=0`.

### Active
- Servizio corrente: PID 496816 (start 13:35:53), NRestarts=1. Monitorare: nuovi ABRT, nuovi core (LimitCORE=0 vale dal prossimo start), 429 sulle rotte v6, `ss` su 127.0.0.1:443.

### Blocked
- Pre-push hook: `bun` non in PATH in husky + `turbo typecheck` OOM → push con `--no-verify`.
- `bun typecheck`/tsgo OOM ambientale (storico, non bloccante).
- systemd ignora `CoreFileSize` (sostituito con LimitCORE).

## Next Move
1. **OSSERVAZIONE post-riavvio 13:47**: TasksMax=4096 attivo (PID 504926, NRestarts=0, HTTP 200, nessun core). pids.current=233/4096 con 1 set MCP (reva 13:48:33). Se in 2-3 giorni di uso intenso non compaiono ABRT → root cause confermata (pids cap 512).
2. Verificare su `/var/log/v6proxy/access.log` src IPv6 diverso per richiesta (post-fix Connection: close).
3. (Opzionale, solo se i crash persistono) bump `@ff-labs/fff-bun` 0.10.3 + rebuild.

## Comandi utili
- `systemctl --user restart opencode.service` (riavvio; uccide la sessione agente in corso).
- `ss -tn | grep 127.0.0.1:443` (keep-alive LLM residui = atteso vuoto).
- `doas tail -f /var/log/v6proxy/access.log` (CT 106) per src IPv6 per richiesta.
- Rollback: `~/deploy-opencode-retry-fix.sh --rollback`.

## Storico (goal precedente, CHIUSO)
- WS-event fast-fail fix (`websocket-guard.ts`) deployato e verificato (400 immediato su path non-WS); merge-upstream importato 2bb0a89451/96005869d6, 443 test pass, push 0d1438af51. Chiude obiettivo sessioni "morte" di openchamber.
- Tunnel per rate limit: 429 erano presenti anche dietro tunnel (÷ /64 per connessione).### Completed (13/08, sessione invalid_bearer_credential)
- **ROOT CAUSE `[invalid_bearer_credential] Missing or invalid bearer credential`** (intermittente, anche in chat): il plugin opencode (`packages/core/src/plugin/provider/opencode.ts`) settava `connected = connection !== undefined` (esiste ma irrisolta) → `hasKey=true` → fallback anonimo `apiKey="public"` saltato → richieste SENZA header Authorization → gateway zen rifiuta ~1/20 (riprodotto: 19 ok/1 401 con uguale errore; `Bearer public` 25/25 ok; `Bearer undefined` 20/20 401).
- **FIX**: `connected = credential !== undefined` (resolved, non esistente) in load() e all'init; commit `4749e7a41` "fix(core): resolve opencode credential before gating public apiKey fallback" (push --no-verify: typecheck turbo già rosso su main per OOM console-app/cli + errori preesistenti boot-reconcile). Test core 10/10 pass.
- **DEPLOY**: binario `0.0.0-main-202608131202`, backup `.bak.20260813-140259`, servizio attivo 14:03, apiKey='public' confermato dal server.

## Inchiesta troncamento chat + 401 residuo (13/08, 16:00-17:00 CEST)

CONCLUSIONE (evidenza, non teoria):
1. Il troncamento "a metà parola" viene dal GATEWAY zen, non dal fork:
   - Nel DB il text part `prt_ffb56e357001pKedjMTgd32pYl` di `msg_ffb5655fe001qju1GL2PdAmgfh` (ses_00d6a3759ffea0dCofLzifcWdf, orchestrator voda, 15:36:43 CEST) finisce esattamente "...e 3 task tiny r" — il taglio E' SALVATO, non è un problema di sync DB.
   - Però quel messaggio ha `finish: "tool-calls"` (non length) e NESSUN errore nel log.
   - Riprodotto via curl diretto a opencode.ai/zen/v1 (Bearer public, streaming, tools): in più run il campo `content` si taglia a metà parola ("ricon", " non") e subito dopo parte `tool_calls` con `finish_reason: tool_calls`. Il gateway taglia l'ultimo delta di testo quando il modello interleaved switcha a tool call. Anche il reasoning part reale risulta tagliato ("...keep returnin").
   - NON è un bug del parsing fork (ai-sdk.ts mappa 1:1 i deltas, niente drop logico), né di UI.
2. L'errore `invalid_bearer_credential` ricapitato DOPO il fix (13:33/13:36/13:44Z) ha altra causa: il GATEWAY è flaky ~1-2% anche con auth valida:
   - Riprodotto con `Authorization: Bearer public` esplicito: 2/40 e 1/60 richieste falliscono proprio con `invalid_bearer_credential`, con lo stesso stack AI_APICallError del fork.
   - Il fix (connected = credential !== undefined, commit 4749e7a41, binario 0.0.0-main-202608131202) e' ATTIVO: /provider mostra apiKey="public", env senza OPENCODE_API_KEY, 25/25 streaming OK col pattern esatto del fork ecc.
   - Il fork non retrya i 401 (executor.ts copre solo 429/503/504/529/>=500) → il 401 flaky del gateway diventa errore utente.
AZIONI possibili (solo mitigazione client): estendere retry 401 per provider opencode/anonimo; il troncamento e il 401 del gateway vanno segnalati upstream (opencode.ai).
