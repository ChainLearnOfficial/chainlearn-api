export interface ApiResponse<T> {
  success: boolean;
  data: T;
  meta: {
    version: string;
    timestamp: string;
    requestId: string;
  };
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface CourseSummaryV1 {
  id: string;
  title: string;
  description: string | null;
  difficulty: string;
  enrolledCount: number;
  isEnrolled: boolean;
}

export interface CourseDetailV1 extends CourseSummaryV1 {
  modules: {
    id: string;
    title: string;
    description: string | null;
    orderIndex: number;
  }[];
}

export interface UserProgressV1 {
  coursesEnrolled: number;
  coursesCompleted: number;
  quizzesPassed: number;
  rewardsEarned: number;
  totalPoints: number;
}

export interface RewardHistoryEntryV1 {
  id: string;
  quizId: string;
  score: number;
  amount: string;
  status: string;
  createdAt: string;
}

export interface CredentialV1 {
  id: string;
  courseId: string;
  courseName: string;
  issuedAt: string;
  transactionHash: string | null;
}
