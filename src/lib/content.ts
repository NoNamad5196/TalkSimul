import type {
  Language,
  Level,
  ScenarioId,
  SessionConfig,
  Message,
  Hint,
  Review,
} from "../../shared/types";
export const languages = {
  en: { name: "영어", native: "English", flag: "EN", locale: "en-US" },
  ja: { name: "일본어", native: "日本語", flag: "JP", locale: "ja-JP" },
};
export const levels: Record<
  Level,
  { name: string; subtitle: string; description: string }
> = {
  beginner: {
    name: "입문",
    subtitle: "천천히, 한 문장부터",
    description: "느린 속도 · 익숙한 단어 · 짧은 질문",
  },
  basic: {
    name: "기본",
    subtitle: "조금 더 이어서 말해요",
    description: "편안한 속도 · 일상 어휘 · 자연스러운 문답",
  },
  challenge: {
    name: "도전",
    subtitle: "내 생각을 자유롭게",
    description: "자연스러운 속도 · 다양한 어휘 · 생각을 묻는 질문",
  },
};
export const scenarios: {
  id: ScenarioId;
  title: string;
  tag: string;
  description: string;
  en: string;
  ja: string;
  color: string;
  role: string;
}[] = [
  {
    id: "free",
    title: "자유 대화",
    tag: "가볍게 수다",
    description: "주제는 없어도 괜찮아. 오늘의 이야기부터!",
    en: "A little chat",
    ja: "気軽におしゃべり",
    color: "orange",
    role: "친근한 대화 친구",
  },
  {
    id: "cafe",
    title: "카페에서 주문하기",
    tag: "일상 한 모금",
    description: "좋아하는 음료와 디저트를 주문해 봐요.",
    en: "At the café",
    ja: "カフェで注文",
    color: "peach",
    role: "작은 카페의 다정한 바리스타",
  },
  {
    id: "hotel",
    title: "호텔 체크인하기",
    tag: "여행의 시작",
    description: "예약을 확인하고 궁금한 것을 물어봐요.",
    en: "Hotel check-in",
    ja: "ホテルのチェックイン",
    color: "sage",
    role: "호텔 프런트 직원",
  },
  {
    id: "friends",
    title: "친구와 주말 이야기",
    tag: "소소한 일상",
    description: "주말에 있었던 일과 다음 약속을 나눠요.",
    en: "Weekend stories",
    ja: "週末の話",
    color: "yellow",
    role: "오랜만에 만난 친구",
  },
  {
    id: "directions",
    title: "길 물어보기",
    tag: "동네 한 바퀴",
    description: "낯선 동네에서도 목적지를 찾아가요.",
    en: "Finding your way",
    ja: "道を尋ねる",
    color: "blue",
    role: "길을 알려 주는 동네 주민",
  },
];
export const scenarioFor = (id: ScenarioId) =>
  scenarios.find((s) => s.id === id)!;
export function greeting(c: SessionConfig): string {
  const en: Record<ScenarioId, string> = {
    free: "Hey, I'm Moru! It's lovely to see you. How has your day been?",
    cafe: "Welcome to our little café! What would you like to drink?",
    hotel: "Welcome! Do you have a reservation with us?",
    friends: "Hey! It's good to see you. What did you do last weekend?",
    directions: "Hi there! Do you need help finding a place?",
  };
  const ja: Record<ScenarioId, string> = {
    free: "こんにちは、モルです！今日はどんな一日でしたか？",
    cafe: "いらっしゃいませ！お飲み物は何になさいますか？",
    hotel: "いらっしゃいませ。ご予約はございますか？",
    friends: "久しぶり！週末は何をしていたの？",
    directions: "こんにちは！どこかお探しですか？",
  };
  const base = (c.language === "en" ? en : ja)[c.scenario];
  if (c.level === "challenge")
    return (
      base +
      (c.language === "en"
        ? " Tell me a little more about what you have in mind."
        : "よかったら、詳しく聞かせてください。")
    );
  if (c.level === "beginner" && c.scenario === "free")
    return c.language === "en"
      ? "Hi! I'm Moru. How are you today?"
      : "こんにちは！モルです。今日は元気ですか？";
  return base;
}
export function demoReply(
  c: SessionConfig,
  messages: Message[],
  text: string,
): string {
  const n = messages.filter((m) => m.role === "user").length;
  if (c.language === "ja") {
    if (/ありがとう/.test(text))
      return "どういたしまして！ほかにも聞きたいことはありますか？";
    const lines: Record<ScenarioId, string[]> = {
      free: [
        "そうなんですね！今日は何をしましたか？",
        "いいですね。何が一番楽しかったですか？",
        "なるほど！明日は何をしたいですか？",
      ],
      cafe: [
        "かしこまりました。ホットとアイス、どちらになさいますか？",
        "サイズはどうなさいますか？",
        "ありがとうございます。店内でお召し上がりですか？",
      ],
      hotel: [
        "ありがとうございます。お名前を教えていただけますか？",
        "朝食は７時からです。何かご質問はありますか？",
        "はい、承知しました。ごゆっくりお過ごしください。",
      ],
      friends: [
        "楽しそう！誰と一緒に行ったの？",
        "いいね！今度、私も一緒に行きたいな。",
        "来週末は何か予定がある？",
      ],
      directions: [
        "駅なら、この道をまっすぐ進んでください。",
        "次の交差点を右に曲がってください。",
        "歩いて５分くらいです。ほかに聞きたいことはありますか？",
      ],
    };
    return lines[c.scenario][n % 3];
  }
  if (/thank/.test(text.toLowerCase()))
    return "You're welcome! Is there anything else you'd like to talk about?";
  const lines: Record<ScenarioId, string[]> = {
    free: [
      "That sounds interesting! What did you do today?",
      "I see! What was your favorite part?",
      "What would you like to do tomorrow?",
    ],
    cafe: [
      "Of course! Would you like that hot or iced?",
      "What size would you like?",
      "Great! Is that for here or to go?",
    ],
    hotel: [
      "Of course. What name is the reservation under?",
      "Breakfast starts at seven. Do you have any questions?",
      "Certainly! Is there anything else you need?",
    ],
    friends: [
      "That sounds fun! Who did you go with?",
      "Nice! I would love to join you next time.",
      "Do you have any plans for next weekend?",
    ],
    directions: [
      "The station is straight down this street.",
      "Turn right at the next intersection.",
      "It is about a five-minute walk. Can I help with anything else?",
    ],
  };
  return lines[c.scenario][n % 3];
}
export function demoHint(c: SessionConfig, messages: Message[]): Hint {
  const last =
    messages.filter((m) => m.role === "assistant").at(-1)?.text ?? "";
  if (c.language === "en") {
    if (/hot or iced/.test(last))
      return { text: "I'd like it iced, please.", meaning: "아이스로 주세요." };
    if (/size/.test(last))
      return { text: "A medium, please.", meaning: "미디엄 사이즈로 주세요." };
    if (/name.*reservation/.test(last))
      return {
        text: "The reservation is under Kim.",
        meaning: "김이라는 이름으로 예약했어요.",
      };
    if (/Who did/.test(last))
      return { text: "I went with a friend.", meaning: "친구와 함께 갔어요." };
    if (/favorite part/.test(last))
      return {
        text: "My favorite part was spending time with my friends.",
        meaning: "친구들과 시간을 보낸 게 가장 좋았어요.",
      };
    const hints: Record<ScenarioId, Hint> = {
      free: {
        text: "I had a pretty good day. I went for a walk.",
        meaning: "꽤 좋은 하루였어요. 산책을 다녀왔어요.",
      },
      cafe: {
        text: "I'd like a latte, please.",
        meaning: "라테 한 잔 주세요.",
      },
      hotel: {
        text: "Yes, I have a reservation for two nights.",
        meaning: "네, 2박 예약했어요.",
      },
      friends: {
        text: "I went to a café with my friend.",
        meaning: "친구와 카페에 갔어요.",
      },
      directions: {
        text: "Excuse me, how can I get to the station?",
        meaning: "실례합니다. 역에 어떻게 가나요?",
      },
    };
    return hints[c.scenario];
  }
  if (/ホットとアイス/.test(last))
    return { text: "アイスでお願いします。", meaning: "아이스로 부탁드려요." };
  if (/サイズ/.test(last))
    return {
      text: "Mサイズをお願いします。",
      meaning: "M 사이즈로 부탁드려요.",
    };
  if (/お名前/.test(last))
    return { text: "キムと申します。", meaning: "김이라고 합니다." };
  if (/誰と/.test(last))
    return { text: "友達と一緒に行ったよ。", meaning: "친구와 함께 갔어." };
  const hints: Record<ScenarioId, Hint> = {
    free: {
      text: "今日は公園で散歩しました。",
      meaning: "오늘은 공원에서 산책했어요.",
    },
    cafe: {
      text: "カフェラテを一つお願いします。",
      meaning: "카페라테 한 잔 부탁드려요.",
    },
    hotel: {
      text: "はい、二泊で予約しています。",
      meaning: "네, 2박으로 예약했어요.",
    },
    friends: {
      text: "友達とカフェに行ったよ。",
      meaning: "친구와 카페에 갔어.",
    },
    directions: {
      text: "すみません、駅はどこですか。",
      meaning: "실례합니다. 역은 어디인가요?",
    },
  };
  return hints[c.scenario];
}
export function demoReview(c: SessionConfig, messages: Message[]): Review {
  const utterances = messages.filter((m) => m.role === "user" && m.text.trim());
  const feedback = utterances.map((m) => {
    let improved = m.text,
      explanation =
        "직접 입력한 문장입니다. 데모에서는 이 문장의 정확성과 자연스러움을 AI가 평가하지 않았어요.",
      category = "발화 돌아보기";
    if (c.language === "en" && /\bI goed\b/i.test(m.text)) {
      improved = m.text.replace(/\bI goed\b/i, "I went");
      explanation =
        "go의 과거형은 went예요. 데모에 준비된 규칙으로 바뀐 부분만 보여 드려요.";
      category = "시제";
    }
    if (c.language === "ja" && /昨日.*行きます/.test(m.text)) {
      improved = m.text.replace("行きます", "行きました");
      explanation =
        "昨日(어제)의 일을 말할 때는 과거형 行きました를 써요. 데모에 준비된 규칙을 적용했어요.";
      category = "말끝 · 시제";
    }
    return {
      messageId: m.id,
      original: m.text,
      improved,
      explanation,
      category,
    };
  });
  return {
    summary: utterances.length
      ? `직접 남긴 ${utterances.length}개의 문장을 모았어요. 한 번 더 소리 내어 말해 볼까요?`
      : "아직 남긴 문장이 없어요. 짧은 한 문장부터 다시 시작해 봐요.",
    feedback,
    assessment: {
      delivery: "음성 평가 안 함",
      naturalness: "AI 평가 안 함",
      grammar: "AI 평가 안 함",
      vocabulary: "AI 평가 안 함",
    },
    insufficient: utterances.length < 2,
  };
}
export const formatTime = (seconds: number) =>
  `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
export const dateLabel = (ms: number) =>
  new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(ms);
