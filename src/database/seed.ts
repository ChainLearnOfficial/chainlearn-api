import { db } from "../config/database.js";
import { users, courses, enrollments, quizzes } from "./schema.js";

async function seed() {
  console.log("Seeding database...");

  // Seed users
  const [alice] = await db
    .insert(users)
    .values({
      stellarAddress: "GALICE0000000000000000000000000000000000000000000000000000000",
      displayName: "Alice Learner",
      background: "Software engineer exploring blockchain",
      learningGoal: "Master Stellar smart contracts",
      pace: "fast",
      credits: 100,
    })
    .returning();

  const [bob] = await db
    .insert(users)
    .values({
      stellarAddress: "GBOB000000000000000000000000000000000000000000000000000000000",
      displayName: "Bob Builder",
      background: "Student new to crypto",
      learningGoal: "Understand DeFi basics",
      pace: "medium",
      credits: 50,
    })
    .returning();

  // Seed courses
  const [course1] = await db
    .insert(courses)
    .values({
      title: "Introduction to Stellar",
      description:
        "Learn the fundamentals of the Stellar network, including accounts, transactions, and the consensus protocol.",
      difficulty: "beginner",
    })
    .returning();

  const [course2] = await db
    .insert(courses)
    .values({
      title: "Soroban Smart Contracts 101",
      description:
        "Build your first smart contract on Soroban. Covers Rust basics, contract lifecycle, and testing.",
      difficulty: "intermediate",
    })
    .returning();

  const [course3] = await db
    .insert(courses)
    .values({
      title: "DeFi on Stellar",
      description:
        "Explore decentralized finance primitives on Stellar: AMMs, lending protocols, and liquidity pools.",
      difficulty: "advanced",
    })
    .returning();

  // Seed enrollments
  await db.insert(enrollments).values([
    { userId: alice.id, courseId: course1.id },
    { userId: alice.id, courseId: course2.id },
    { userId: bob.id, courseId: course1.id },
  ]);

  // Seed a quiz
  await db.insert(quizzes).values({
    courseId: course1.id,
    moduleId: "module-1",
    questions: [
      {
        id: "q1",
        text: "What consensus protocol does Stellar use?",
        options: [
          "Proof of Work",
          "Stellar Consensus Protocol (SCP)",
          "Proof of Stake",
          "Delegated PoS",
        ],
        correctIndex: 1,
      },
      {
        id: "q2",
        text: "What is the native token of the Stellar network?",
        options: ["ETH", "SOL", "XLM", "BTC"],
        correctIndex: 2,
      },
      {
        id: "q3",
        text: "Which operation creates a new account on Stellar?",
        options: ["Payment", "CreateAccount", "ManageData", "SetOptions"],
        correctIndex: 1,
      },
    ],
    generatedFor: alice.id,
  });

  console.log("Seed complete.");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
