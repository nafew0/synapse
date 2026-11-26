/** Memory keys sent with every message: small, and they shape almost every reply. */
export const CORE_MEMORY_KEYS: readonly string[] = [
  'personal_info',
  'preferences',
  'communication_style',
];

/** Words that point a message at a key even when its saved facts use other words. */
const KEY_CUES: Readonly<Record<string, readonly string[]>> = {
  work_info: [
    'work',
    'job',
    'office',
    'company',
    'colleague',
    'department',
    'university',
    'college',
    'school',
    'teach',
    'teaching',
    'lecture',
    'class',
    'course',
    'student',
    'students',
    'study',
    'career',
    'বিশ্ববিদ্যালয়',
    'অফিস',
    'চাকরি',
    'বিভাগ',
    'ক্লাস',
    'ছাত্র',
    'শিক্ষার্থী',
    'পড়াই',
    'শিক্ষক',
    'প্রতিষ্ঠান',
  ],
  context: [
    'thesis',
    'research',
    'project',
    'paper',
    'dissertation',
    'chapter',
    'proposal',
    'assignment',
    'গবেষণা',
    'থিসিস',
    'প্রজেক্ট',
    'প্রকল্প',
    'পেপার',
  ],
  interests: ['hobby', 'hobbies', 'interest', 'interests', 'enjoy', 'শখ', 'আগ্রহ'],
};

/** Phrases asking what is remembered: every saved fact is sent. */
const ABOUT_ME = [
  'about me',
  'who am i',
  'remember about',
  'know about',
  'my profile',
  'my memory',
  'আমার সম্পর্কে',
  'আমি কে',
  'আমার ব্যাপারে',
];

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'have',
  'has',
  'you',
  'your',
  'are',
  'was',
  'were',
  'will',
  'can',
  'could',
  'would',
  'should',
  'what',
  'how',
  'why',
  'when',
  'where',
  'which',
  'who',
  'please',
  'give',
  'make',
  'write',
  'tell',
  'about',
  'some',
  'into',
  'also',
  'user',
  "user's",
  'users',
  'এবং',
  'আমার',
  'আমাকে',
  'আপনার',
  'তোমার',
  'জন্য',
  'থেকে',
  'দিয়ে',
  'করতে',
  'করে',
  'একটি',
  'একটা',
  'কিন্তু',
  'আছে',
  'হবে',
  'দাও',
  'দিন',
]);

const WORD = /[\p{L}\p{M}\p{N}']+/gu;
const FACT_BOUNDARY = /(?<=[.!?।])\s+/u;
/** Long words match on their first letters, so "universities" finds "university"
 *  and "বিশ্ববিদ্যালয়ের" finds "বিশ্ববিদ্যালয়". */
const STEM_LENGTH = 6;

const stem = (word: string): string => {
  const letters = Array.from(word);
  return letters.length > STEM_LENGTH ? letters.slice(0, STEM_LENGTH).join('') : word;
};

/** Meaningful word stems of a text, lower-cased, without common words. */
function stemsOf(text: string): Set<string> {
  const stems = new Set<string>();
  for (const match of text.toLowerCase().matchAll(WORD)) {
    const word = match[0];
    if (Array.from(word).length < 3 || STOP_WORDS.has(word)) {
      continue;
    }
    stems.add(stem(word));
  }
  return stems;
}

const sharesStem = (fact: string, messageStems: ReadonlySet<string>): boolean => {
  for (const factStem of stemsOf(fact)) {
    if (messageStems.has(factStem)) {
      return true;
    }
  }
  return false;
};

export interface MemorySelection {
  /** Selected facts, numbered one per line; empty when none apply */
  text: string;
  shown: number;
  total: number;
}

/**
 * Picks the saved facts worth sending with a message: every fact under the core
 * keys, plus facts under other keys that share a word with the user's recent
 * messages or whose key the messages point at. A question about what is
 * remembered gets every fact.
 */
export function selectMemoriesForMessage({
  valuesByKey,
  messages,
  coreKeys = CORE_MEMORY_KEYS,
}: {
  valuesByKey: ReadonlyMap<string, string>;
  /** The user's latest messages, newest last */
  messages: readonly string[];
  coreKeys?: readonly string[];
}): MemorySelection {
  const messageText = messages.join('\n').toLowerCase();
  const messageStems = stemsOf(messageText);
  const wantsEverything = ABOUT_ME.some((phrase) => messageText.includes(phrase));
  const selected: string[] = [];
  let total = 0;

  for (const [key, value] of valuesByKey) {
    const facts = value
      .split(FACT_BOUNDARY)
      .map((fact) => fact.trim())
      .filter(Boolean);
    total += facts.length;
    const keyRequested =
      wantsEverything ||
      coreKeys.includes(key) ||
      (KEY_CUES[key] ?? []).some((cue) => messageStems.has(stem(cue)));
    for (const fact of facts) {
      if (keyRequested || sharesStem(fact, messageStems)) {
        selected.push(fact);
      }
    }
  }

  return {
    text: selected.map((fact, index) => `${index + 1}. ${fact}`).join('\n'),
    shown: selected.length,
    total,
  };
}

export interface PromptMemoryText {
  /** Memory text for the prompt; undefined when nothing applies */
  text?: string;
  /** Some saved facts were left out because they did not match the message */
  partial: boolean;
  /** The user has saved memories, whether or not any were selected */
  hasSaved: boolean;
}

/**
 * Chooses the memory text for a chat agent's prompt. Agents that manage memory
 * themselves (keyed) see everything; others get the facts selected for the
 * user's recent messages. Without per-key values it falls back to everything.
 */
export function memoryTextForPrompt({
  memories,
  keyed,
  recentMessages,
}: {
  memories?: {
    withKeys?: string;
    withoutKeys?: string;
    valuesByKey?: ReadonlyMap<string, string>;
  };
  keyed: boolean;
  recentMessages: readonly string[];
}): PromptMemoryText {
  if (!memories) {
    return { partial: false, hasSaved: false };
  }
  const full = keyed ? memories.withKeys : memories.withoutKeys;
  if (keyed || !memories.valuesByKey) {
    return { text: full || undefined, partial: false, hasSaved: Boolean(full) };
  }
  const { text, shown, total } = selectMemoriesForMessage({
    valuesByKey: memories.valuesByKey,
    messages: recentMessages,
  });
  return { text: text || undefined, partial: shown < total, hasSaved: total > 0 };
}
