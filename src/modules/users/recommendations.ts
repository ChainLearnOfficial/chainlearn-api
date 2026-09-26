/**
 * Course recommendation scoring (#375).
 *
 * A candidate course is scored from four signals, each in the range 0-1 and
 * weighted; the weighted sum is the recommendation's confidence (0-1):
 *
 * - Tag overlap (0.35): content-based, how much of the course's tags match the
 *   tags of courses the user completed or enrolled in.
 * - Learning goal (0.25): keywords from the user's stated goal and background
 *   found in the course's title, description or tags.
 * - Difficulty fit (0.2): the course's level against the level the user is
 *   ready for, from the highest completed level, average quiz score and pace.
 * - Peer popularity (0.2): collaborative, how many learners who took the same
 *   courses as the user also enrolled in this one.
 */

export const DIFFICULTY_ORDER = ["beginner", "intermediate", "advanced"] as const;

const WEIGHTS = { tags: 0.35, goal: 0.25, difficulty: 0.2, peers: 0.2 } as const;

export interface RecommendationProfile {
  learningGoal: string | null;
  background: string | null;
  pace: string | null;
  /** Lower-cased tags of courses the user completed or enrolled in. */
  interestTags: string[];
  /** Index into DIFFICULTY_ORDER of the hardest completed course, or -1. */
  highestCompletedLevel: number;
  /** Mean quiz score percentage (0-100), or null with no submissions. */
  averageScorePercent: number | null;
}

export interface CandidateCourse {
  id: string;
  title: string;
  description: string;
  difficulty: string;
  tags: string[];
  /** Peers (users who share courses with this user) enrolled in it. */
  peerEnrollments: number;
}

export interface ScoredCourse {
  courseId: string;
  courseTitle: string;
  difficulty: string;
  tags: string[];
  /** 0-1, two decimals. */
  confidence: number;
  reasons: string[];
}

function keywords(text: string | null): string[] {
  if (!text) return [];
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 4),
    ),
  ];
}

/** The difficulty level (index) the user is ready for. */
export function targetLevel(profile: RecommendationProfile): number {
  const top = DIFFICULTY_ORDER.length - 1;
  let level = Math.min(profile.highestCompletedLevel + 1, top);
  if (level < 0) level = 0;

  const score = profile.averageScorePercent;
  if (score !== null && score < 60) {
    // Struggling: consolidate at the level already reached.
    level = Math.max(profile.highestCompletedLevel, 0);
  } else if (score !== null && score >= 85 && profile.pace === "fast") {
    level = Math.min(level + 1, top);
  } else if (profile.pace === "slow" && profile.highestCompletedLevel >= 0) {
    level = Math.max(profile.highestCompletedLevel, 0);
  }
  return level;
}

export function scoreCourse(
  profile: RecommendationProfile,
  course: CandidateCourse,
  maxPeerEnrollments: number,
): ScoredCourse {
  const reasons: string[] = [];
  const courseTags = course.tags.map((t) => t.toLowerCase());
  const interests = new Set(profile.interestTags.map((t) => t.toLowerCase()));

  const sharedTags = courseTags.filter((t) => interests.has(t));
  const tagSignal = courseTags.length > 0 ? sharedTags.length / courseTags.length : 0;
  if (sharedTags.length > 0) {
    reasons.push(`Related to topics you have studied: ${sharedTags.join(", ")}`);
  }

  const goalWords = keywords(`${profile.learningGoal ?? ""} ${profile.background ?? ""}`);
  const haystack = `${course.title} ${course.description} ${courseTags.join(" ")}`.toLowerCase();
  const matchedGoalWords = goalWords.filter((word) => haystack.includes(word));
  const goalSignal = Math.min(1, matchedGoalWords.length / 3);
  if (matchedGoalWords.length > 0) {
    reasons.push("Matches your learning goal");
  }

  const level = DIFFICULTY_ORDER.indexOf(course.difficulty as (typeof DIFFICULTY_ORDER)[number]);
  const distance = level === -1 ? 2 : Math.abs(level - targetLevel(profile));
  const difficultySignal = distance === 0 ? 1 : distance === 1 ? 0.5 : 0;
  if (difficultySignal === 1) {
    reasons.push(`A good next step at the ${course.difficulty} level`);
  }

  const peerSignal = maxPeerEnrollments > 0 ? course.peerEnrollments / maxPeerEnrollments : 0;
  if (course.peerEnrollments > 0) {
    reasons.push("Popular with learners who took the same courses");
  }

  const confidence =
    tagSignal * WEIGHTS.tags +
    goalSignal * WEIGHTS.goal +
    difficultySignal * WEIGHTS.difficulty +
    peerSignal * WEIGHTS.peers;

  return {
    courseId: course.id,
    courseTitle: course.title,
    difficulty: course.difficulty,
    tags: course.tags,
    confidence: Math.round(Math.min(1, confidence) * 100) / 100,
    reasons,
  };
}

/** Score, rank (highest confidence first) and trim to `limit` recommendations. */
export function rankCourses(
  profile: RecommendationProfile,
  candidates: CandidateCourse[],
  limit = 10,
): ScoredCourse[] {
  const maxPeers = candidates.reduce((max, c) => Math.max(max, c.peerEnrollments), 0);
  return candidates
    .map((course) => scoreCourse(profile, course, maxPeers))
    .filter((scored) => scored.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence || a.courseTitle.localeCompare(b.courseTitle))
    .slice(0, limit);
}
