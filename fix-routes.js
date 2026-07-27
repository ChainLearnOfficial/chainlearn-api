const fs = require('fs');

// auth.routes.ts
let auth = fs.readFileSync('src/modules/auth/auth.routes.ts', 'utf8');
auth = auth.replace('app.post(', 'app.post<{ Body: import("./auth.types.js").ChallengeBody }>(');
auth = auth.replace('app.post(', 'app.post<{ Body: import("./auth.types.js").VerifyBody }>(');
fs.writeFileSync('src/modules/auth/auth.routes.ts', auth);

// course.routes.ts
let course = fs.readFileSync('src/modules/courses/course.routes.ts', 'utf8');
course = course.replace('app.get(', 'app.get<{ Querystring: import("./course.types.js").ListCoursesQuery }>(');
course = course.replace('app.get(', 'app.get<{ Params: { id: string } }>(');
course = course.replace('app.post(', 'app.post<{ Params: { id: string } }>(');
fs.writeFileSync('src/modules/courses/course.routes.ts', course);

// credential.routes.ts
let cred = fs.readFileSync('src/modules/credentials/credential.routes.ts', 'utf8');
cred = cred.replace('app.post(', 'app.post<{ Body: import("./credential.types.js").MintCredentialBody }>(');
fs.writeFileSync('src/modules/credentials/credential.routes.ts', cred);

// quiz.routes.ts
let quiz = fs.readFileSync('src/modules/quizzes/quiz.routes.ts', 'utf8');
quiz = quiz.replace('app.post(', 'app.post<{ Body: import("./quiz.types.js").GenerateQuizBody }>(');
quiz = quiz.replace('app.post(', 'app.post<{ Params: { id: string }, Body: import("./quiz.types.js").SubmitQuizBody }>(');
fs.writeFileSync('src/modules/quizzes/quiz.routes.ts', quiz);

// reward.routes.ts
let reward = fs.readFileSync('src/modules/rewards/reward.routes.ts', 'utf8');
reward = reward.replace('app.post(', 'app.post<{ Body: import("./reward.types.js").ClaimRewardBody }>(');
fs.writeFileSync('src/modules/rewards/reward.routes.ts', reward);

// user.routes.ts
let user = fs.readFileSync('src/modules/users/user.routes.ts', 'utf8');
user = user.replace('app.put(', 'app.put<{ Body: import("./user.types.js").UpdateProfileBody }>(');
fs.writeFileSync('src/modules/users/user.routes.ts', user);
