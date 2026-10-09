# AI 연결 구현 근거

확인 날짜: 2026-10-09. 공식 OpenAI 문서를 직접 열어 확인했습니다. 기본 서버 단위 테스트에서는 외부 모델을 호출하지 않습니다. 사용자 승인 후 실제 Responses 힌트와 합성 음성 생성에 성공했으며, 실연결 검사 결과는 [검증 기록](../docs/VERIFICATION.md)에 따로 기록합니다. 계정의 실제 청구 금액은 조회하지 않았습니다.

- [WebRTC 공식 문서](https://developers.openai.com/api/docs/guides/voice-webrtc)의 **Realtime API / unified interface**에 따라 `POST /v1/realtime/calls`에 SDP와 session JSON을 multipart로 전송합니다. 같은 페이지의 GPT-Live API와 섞지 않았습니다. 일반 API 키는 서버에서만 사용하고 브라우저에는 SDP 응답만 반환합니다.
- [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)에 나오는 `gpt-realtime-2.1`을 음성 기본 모델로 정했습니다. `output_modalities: ["audio"]`로 음성과 전사 이벤트를 받습니다.
- [Realtime client events](https://developers.openai.com/api/reference/resources/realtime/client-events)의 `audio.input.transcription`, `semantic_vad`, `audio.output.speed` 설정을 사용합니다. 전사는 모델이 들은 원본과 완전히 같다고 보장되지 않으므로 UI에서 인식된 텍스트로 취급해야 합니다. 기본 전사 모델은 이 API에서 지원하는 `gpt-4o-mini-transcribe`입니다.
- 사용자 요청에 따라 힌트·복기 기본 모델을 `gpt-6-luna`로 변경했습니다. [GPT-6 Luna 모델 문서](https://developers.openai.com/api/docs/models/gpt-6-luna)에서 Responses, Structured Outputs 및 `reasoning.effort: low` 지원을 확인했습니다. 기존 Responses 요청과 `low` 설정, 한국어 설명·원문 근거 검증 계약을 유지합니다. 오디오는 지원하지 않으므로 회화·전사·TTS 모델은 그대로 사용합니다. 계정별 모델 접근 권한은 다를 수 있습니다.
- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)의 Responses `text.format` JSON Schema 방식으로 힌트와 복기를 요청합니다. 서버에서 다시 검사하고, 복기의 `messageId` 및 `original`이 실제 사용자 발화와 정확히 일치하는지 확인합니다. 형식 보장만으로 사실성을 보장할 수 없으므로 이 검증이 별도로 필요합니다.
- [Text to speech](https://developers.openai.com/api/docs/guides/text-to-speech)의 `POST /v1/audio/speech`를 실제 모드의 발음 대체 경로로 사용합니다. `gpt-4o-mini-tts`, `marin`, MP3 형식이며 선택 언어와 난이도별 속도를 반영합니다. 기기 음성이 없거나 실패할 때만 요청하며, 화면에서 AI 생성 음성임을 알립니다. 데모에서는 호출하지 않습니다.

## 안전한 로컬 설정

프로젝트의 `.env.example`을 `.env`로 복사하고 키를 로컬 파일에서 입력합니다. 키를 채팅에 보내거나 `VITE_` 환경 변수에 넣지 마세요. `.env`는 Git에서 제외합니다. `TALK_SIMUL_ENABLE_PAID_API=false`가 기본이며, 키가 있어도 `true`로 명시하기 전에는 외부 API 요청을 보내지 않습니다.

`OPENAI_TEXT_MODEL`을 명시한 기존 로컬·Vercel 환경에서는 해당 값이 코드의 기본값보다 우선합니다. 기본 모델 변경만으로 기존 배포 환경변수나 과거 실검증 기록이 바뀌지는 않습니다.

실제 모드를 시작하면 마이크 음성이 브라우저의 WebRTC 연결을 통해 OpenAI로 전송됩니다. 힌트·복기에는 선택 설정과 필요한 대화 전사가 서버를 거쳐 OpenAI Responses API로 전송됩니다. 서버는 원본 음성, 전사, 키를 파일이나 로그에 기록하지 않습니다. `store:false`는 Responses 저장 옵션이며 제공자의 다른 데이터 보존 정책까지 끄는 뜻은 아닙니다. 로컬 연습 기록은 프론트엔드의 기기 저장소를 사용합니다.

## 로컬 API

`127.0.0.1:3001`에만 바인딩합니다. 허용 브라우저 출처는 `localhost` 또는 `127.0.0.1`의 3001, 5188, 4173 포트입니다. 개발 모드에서는 Vite가 `/api`를 서버로 프록시합니다. 공개 배포용 인증 체계는 이 MVP에 포함하지 않았습니다.

| 경로                 | 입력                 | 출력                                         |
| -------------------- | -------------------- | -------------------------------------------- |
| `GET /api/status`    | 없음                 | 키 존재 여부, 유료 연결 활성 여부, 모델 이름 |
| `POST /api/realtime` | `{sdp, config}`      | `{sdp}`                                      |
| `POST /api/hint`     | `{config, messages}` | `{text, meaning, note}`                      |
| `POST /api/review`   | `{config, messages}` | `Review`                                     |
| `POST /api/speech`   | `{config, text}`     | `{audio: base64, mimeType: "audio/mpeg"}`    |

POST는 `Content-Type: application/json`과 허용 Origin이 필요합니다. 설정은 공유 타입의 언어·난이도·상황을 검증하며 `mode: "live"`만 허용합니다. 샘플 대화는 실제 복기로 보내지 않습니다. 메시지 ID는 고유해야 하며 160개, 각 8,000자, 합계 60,000자로 제한합니다. 외부 요청은 45초 제한, 분당 30개와 동시 3개의 제한을 둡니다. 실패는 정제된 한국어 오류와 코드로 반환하며 데모 응답으로 바꾸지 않습니다.

실제 사용자의 의미 있는 발화가 2개 미만이거나 문자량이 극히 적으면 외부 평가를 요청하지 않고 `insufficient`를 반환합니다. 평가 문구는 전사만으로 확인 가능한 전달력·자연스러움·문법·어휘에 한정하고, 발음이나 억양을 들었다고 주장하지 않도록 지시합니다. 모델 피드백은 여전히 오판할 수 있어 원문을 함께 보여줍니다.

## 실연결 검증 결과

사용자 승인 후 영어·일본어 모두 합성 WAV 입력으로 실제 SDP 연결, 양방향 오디오 패킷, 전사 이벤트, 힌트 뒤 재개, 종료 정리와 발화 기반 복기를 확인했습니다. 영어의 기기 음성 부재 시 API MP3 대체 재생, 일본어의 정상 기기 음성 재생을 각각 확인했습니다. 사람의 실제 마이크·스피커 청취는 검증하지 않았습니다.

실제 일본어 복기가 원문 뜻을 바꾼 사례를 발견해 의미 보존과 상황 조언을 분리하도록 지침을 보강했습니다. 같은 전사로 재검증했고, 이미 자연스러운 문장은 강제로 교정하지 않습니다. 설명의 한국어 규칙은 명시 지시와 한글을 포함해야 하는 스키마 검증을 함께 적용합니다. 이는 뜻이나 언어 품질을 완전히 보장하는 검사가 아니므로 원문을 보존하고 한계를 안내합니다. [최종 실검증 증거](../docs/live-verification.json)를 참고하세요.
