# Voice agent latency report

20 turns across four localhost calls in **mock** mode. The driver replayed 16 kHz mono recorded speech over WebSocket in real time. Measurements were read back from SQLite through the session endpoint.

| Stage | Median (ms) | P90 (ms) |
| --- | ---: | ---: |
| VAD end detection | 600 | 604 |
| STT finalization | 0 | 0 |
| LLM first text | 0 | 1 |
| First text to first TTS audio | 1 | 2 |
| Speech end to first server audio | 602 | 606 |

Speech end is the receipt of the final voiced frame according to the server VAD. The TTS interval includes sentence buffering. Total ends when the server receives the first PCM chunk. This driver acknowledges playback immediately, so it does not measure speaker onset.

Median is the average of the two central samples, and p90 is nearest rank.

This run used scripted transcripts, deterministic LLM output and prerecorded replies. It verifies local transport and instrumentation. Live-provider latency and the 1.5 s acceptance target still require a live run.
