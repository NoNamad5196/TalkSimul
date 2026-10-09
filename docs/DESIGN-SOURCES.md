# TalkSimul 디자인 출처와 에셋

확인일: 2026-10-09 (한국 시간)

## 실제로 확인한 공개 레퍼런스

모든 레퍼런스는 공개 웹 페이지를 브라우저에서 열어 실제 이미지와 화면을 확인했다. 아래 이미지는 조사에만 사용했고 앱 파일에 복제하거나 포함하지 않았다. 각 서비스의 캐릭터·로고·스크린샷은 해당 권리자 소유다.

| 출처                                                                                                                              | 직접 확인한 화면                                                                                                                                         | 참고한 특징                                                                       | TalkSimul 반영 방향                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [트릭컬: 리바이브 — EPIDGames 공식 Google Play](https://play.google.com/store/apps/details?id=com.epidgames.trickcalrevive&hl=ko) | 공개 스크린샷 갤러리의 우이 캐릭터 화면. 큰 볼과 짧은 몸, 둥근 표정, 두꺼운 브라운 계열 선, 스티커처럼 둘러진 흰 테두리, 밝은 연두·노랑 색면을 시각 확인 | 통통한 SD 비율, 표정 전달, 말랑한 형태, 작은 소품, 친근하고 장난스러운 느낌       | 새로운 캐릭터 모루, 주황·크림·브라운 팔레트, 둥근 버튼과 말풍선, 같은 선 두께의 소품. 게임 캐릭터·의상·로고·재화 시스템은 사용하지 않음 |
| [오픽미 공식 홈페이지](https://www.opicme.kr/)                                                                                    | 공개 소개 영역의 결과 화면과 ‘내 답변’ 문장 카드. 원문 안에 고칠 표현을 색으로 강조하는 화면을 시각 확인                                                 | 원문과 개선할 지점의 연결, 짧은 설명, 문장 단위 복습                              | 세션에서 실제로 말한 문장 → 개선 표현 → 한국어 이유 순서. 시험 등급 중심 구조 대신 말하기 경험과 표현 개선을 강조                       |
| [토스미 공식 홈페이지](https://www.tosme.kr/home)                                                                                 | 공개 소개 영역의 모의고사·실전문제·템플릿·마이노트 2×2 선택 버튼과 휴대폰 학습 화면을 시각 확인                                                          | 시작할 학습과 복습을 명확히 나누는 구조, 읽기 쉬운 문장 영역, 되찾을 수 있는 기록 | 자유 대화를 첫 행동으로, 상황 선택과 연습 기록을 별도 진입점으로 구성. 토스미의 보라색은 채택하지 않음                                  |

조사는 공개 소개 및 공식 스토어 화면 범위다. 로그인한 서비스 내부 기능을 사용했다고 주장하지 않는다. 홈페이지의 홍보 수치나 효과 주장은 TalkSimul 기능 근거로 사용하지 않았다.

## TalkSimul 오리지널 캐릭터: 모루

- 파일: `public/assets/moru-states.png`
- 제작: Codex 기본 내장 `image_gen` 도구, 2026-10-09. CLI/API 키 방식은 사용하지 않았다.
- 용도: 홈, 연결 상태, 회화, 복기, 빈 상태에서 사용하는 한 명의 대화 친구.
- 형태: 크림색 빵처럼 둥근 여우, 큰 머리와 살구색 볼·귀, 짧은 팔다리, 연두 목수건, 따뜻한 브라운 외곽선.
- 기존 게임 캐릭터를 편집하거나 복제한 에셋이 아니다. 레퍼런스 이미지를 생성 입력으로 첨부하지 않고 일반적인 비율·색면·친근함을 바탕으로 새로운 캐릭터를 생성했다.
- 1536 × 1024 PNG, 알파 포함, 정확한 3열 × 2행. 셀마다 512 × 512.
- 파일을 그대로 복사해 사용했다. 이미지 편집·배경 제거 스크립트는 사용하지 않았다.
- 이미지의 여섯 자세를 육안으로 확인했고, 파일의 모서리와 셀 간 빈 공간 알파가 0인 것을 검사했다. 일부 이미지 미리보기는 투명 픽셀의 RGB 색(갈색)을 표시할 수 있으나 실제 PNG 배경은 알파로 투명하다.

| 상태                | 열 / 행 (0부터) | CSS background-position |
| ------------------- | --------------- | ----------------------- |
| 기본 `neutral`      | 0 / 0           | `0% 0%`                 |
| 반가움 `welcoming`  | 1 / 0           | `50% 0%`                |
| 듣기 `listening`    | 2 / 0           | `100% 0%`               |
| 말하기 `speaking`   | 0 / 1           | `0% 100%`               |
| 생각하기 `thinking` | 1 / 1           | `50% 100%`              |
| 응원 `encouraging`  | 2 / 1           | `100% 100%`             |

정사각형 요소에 `background-size: 300% 200%`로 표시한다. 캐릭터의 오류 상태에 비웃음·실망 표정을 사용하지 않는다.

## 생성에 사용한 최종 프롬프트

```text
Use case: stylized-concept.
Asset type: original transparent PNG sprite sheet for TalkSimul, a friendly English/Japanese conversation practice app.
Create an ORIGINAL mascot called Moru: a very chubby cream-colored little fox/bread creature, oversized head and puffy rounded cheeks, extremely short rounded limbs, little peach-orange triangular ears, tiny cinnamon nose, dark warm brown simple dot/arc eyes, small green neckerchief, a little fluffy fox tail. Endearing, gently silly, welcoming, never smug or mocking. Flat polished kawaii SD illustration with thick even warm brown (#543C30) outlines, soft warm cream (#FFF7E8) body, peach blush/ears (#FFE2C2), orange (#F58A36) details, muted leaf green (#B9CE8B) neckerchief. Solid clean color areas, minimal shading.
Composition: Exactly SIX equal SQUARE cells in a precise 3 column by 2 row grid, total canvas landscape 1536 x 1024, each cell 512 x 512. No visible grid lines or labels. One full body Moru in each cell, consistently sized and centered. Head/body character fills roughly 78% of each cell with generous safe transparent margins. All six are the exact same creature and colors.
Left-to-right TOP row: 1. NEUTRAL gentle closed smile and relaxed paws; 2. WELCOMING joyful eyes and one paw waving hello; 3. LISTENING head slightly tilted, one paw cupped by an ear, attentive eyes and tiny closed mouth.
Left-to-right BOTTOM row: 4. SPEAKING small cheerful open mouth, one conversational paw gesture; 5. THINKING paw at cheek, gently thoughtful eyes looking up; 6. ENCOURAGING eyes smiling like crescents, both paws up in gentle celebration.
Actual fully transparent background and space between characters. All character edges clean, no white rectangle or checkerboard printed. No props except the little green neckerchief. No speech bubbles, no letters, no text, no watermarks, no brand logos, no labels, no environment, no cast shadows, no art crossing cell boundaries. Do not copy existing game characters, their costumes, or distinctive markings.
```

## 전체 UI의 시각적 규칙

주황 `#F58A36`, 진한 주황 `#D96A24`, 크림 배경 `#FFF7E8`, 콘텐츠 표면 `#FFFDF7`, 브라운 텍스트·외곽선 `#543C30`, 보조 텍스트 `#806B5D`, 살구 `#FFE2C2`, 소량의 연두 `#B9CE8B`를 출발점으로 사용한다. 버튼·말풍선·아이콘·빈 화면·로딩에도 둥근 형태와 브라운 선을 함께 사용하며, 학습 문장 읽기와 대화 동작이 장식보다 우선이다.
