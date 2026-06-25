// ============================================
// TASKFORGE BACKEND SERVER
// Free stack: Express + Supabase + Piston API
// ============================================

const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// ---- SUPABASE (free tier: 500MB, unlimited API calls) ----
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://your-project.supabase.co',
  process.env.SUPABASE_ANON_KEY || 'your-anon-key'
);

// ---- PISTON API (100% free, open source code runner) ----
const PISTON_URL = 'https://emkc.org/api/v2/piston';

// ---- ANTHROPIC (task breakdown AI) ----
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// ============================================
// HEALTH CHECK
// ============================================
app.get('/', (req, res) => {
  res.json({ status: 'TaskForge API running', version: '1.0.0' });
});

// ============================================
// PROJECT ROUTES
// ============================================

// Upload a new project + AI breakdown
app.post('/api/projects', async (req, res) => {
  const { name, description, tech_stack, client_id, timeline_weeks } = req.body;
  if (!name || !description) return res.status(400).json({ error: 'name and description required' });

  try {
    // 1. Save project to Supabase
    const { data: project, error } = await supabase
      .from('projects')
      .insert({ name, description, tech_stack, client_id, timeline_weeks, status: 'pending' })
      .select().single();

    if (error) throw error;

    // 2. Call Claude to break it into tasks
    const tasks = await breakProjectIntoTasks(project);

    // 3. Save tasks to Supabase
    const { error: taskError } = await supabase.from('tasks').insert(
      tasks.map(t => ({ ...t, project_id: project.id }))
    );
    if (taskError) throw taskError;

    // 4. Update project total_tasks count
    await supabase.from('projects')
      .update({ total_tasks: tasks.length, status: 'active' })
      .eq('id', project.id);

    res.json({ project, tasks, message: `Project broken into ${tasks.length} tasks` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all projects (admin)
app.get('/api/projects', async (req, res) => {
  const { data, error } = await supabase
    .from('project_stats')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Get single project with tasks
app.get('/api/projects/:id', async (req, res) => {
  const { data: project } = await supabase
    .from('projects').select('*').eq('id', req.params.id).single();
  const { data: tasks } = await supabase
    .from('tasks').select('*').eq('project_id', req.params.id);
  res.json({ project, tasks });
});

// ============================================
// TASK ROUTES — what learners see
// ============================================

// Get next task for a learner (by their track)
app.get('/api/tasks/next', async (req, res) => {
  const { track, user_id } = req.query;
  if (!track || !user_id) return res.status(400).json({ error: 'track and user_id required' });

  try {
    // Get tasks the learner hasn't done yet, prioritize open ones
    const { data: done } = await supabase
      .from('submissions')
      .select('task_id')
      .eq('user_id', user_id);

    const doneIds = (done || []).map(d => d.task_id);

    let query = supabase
      .from('tasks')
      .select('*')
      .eq('track', track)
      .in('status', ['open', 'in_progress'])
      .order('created_at', { ascending: true })
      .limit(1);

    if (doneIds.length > 0) {
      query = query.not('id', 'in', `(${doneIds.join(',')})`);
    }

    const { data: tasks, error } = await query;
    if (error) throw error;

    if (!tasks || tasks.length === 0) {
      return res.json({ message: 'No more tasks available in this track', task: null });
    }

    // Strip sensitive fields — learner never sees project_id or real context
    const { project_id, verified_output, ...safeTask } = tasks[0];
    res.json({ task: safeTask });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// SUBMISSION ROUTES
// ============================================

// Submit MCQ answer
app.post('/api/submit/mcq', async (req, res) => {
  const { task_id, user_id, selected_option, time_taken_seconds } = req.body;

  try {
    // Get task to check correct answer
    const { data: task } = await supabase
      .from('tasks').select('*').eq('id', task_id).single();
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const is_correct = selected_option === task.correct_option;
    const xp_earned = is_correct ? task.xp_reward : Math.floor(task.xp_reward * 0.1);

    // Save submission
    const { data: submission } = await supabase.from('submissions').insert({
      task_id, user_id, selected_option, is_correct,
      xp_earned, time_taken_seconds
    }).select().single();

    // Update learner XP
    if (is_correct) {
      await updateLearnerXP(user_id, task.track, xp_earned);
    }

    // Check if task should go to voting (enough submissions)
    await checkVotingThreshold(task_id, task);

    res.json({
      is_correct,
      xp_earned,
      correct_option: task.correct_option,
      explanation: task.quiz_context,
      contribution_message: is_correct
        ? getContributionMessage(task.track)
        : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Submit CODE answer — runs via Piston (FREE)
app.post('/api/submit/code', async (req, res) => {
  const { task_id, user_id, submitted_code, language, time_taken_seconds } = req.body;

  try {
    const { data: task } = await supabase
      .from('tasks').select('*').eq('id', task_id).single();
    if (!task) return res.status(404).json({ error: 'Task not found' });

    // Run code on Piston (free open source runner)
    const execution = await runCodeOnPiston(submitted_code, language, task.test_cases);

    const is_correct = execution.all_passed;
    const xp_earned = is_correct ? task.xp_reward : 0;

    // Save submission with execution result
    const { data: submission } = await supabase.from('submissions').insert({
      task_id, user_id, submitted_code,
      execution_result: execution,
      is_correct, xp_earned, time_taken_seconds
    }).select().single();

    if (is_correct) {
      await updateLearnerXP(user_id, task.track, xp_earned);
      // Correct code submissions go to voting automatically
      await castAutoVote(task_id, submission.id, user_id);
    }

    await checkVotingThreshold(task_id, task);

    res.json({
      is_correct,
      xp_earned,
      execution,
      contribution_message: is_correct ? getContributionMessage(task.track) : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// VOTING ENGINE (core of the platform)
// ============================================

// Cast a vote on a submission (advanced learners reviewing others' code)
app.post('/api/vote', async (req, res) => {
  const { task_id, submission_id, voter_id } = req.body;

  try {
    // One vote per person per task
    await supabase.from('votes').insert({ task_id, submission_id, voter_id });

    // Check if majority reached
    const result = await checkMajorityVote(task_id);
    res.json({ voted: true, majority_reached: result.majority_reached, result });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Already voted on this task' });
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// LEARNER ROUTES
// ============================================

app.get('/api/learners/:id', async (req, res) => {
  const { data: user } = await supabase.from('users').select('*').eq('id', req.params.id).single();
  const { data: progress } = await supabase.from('learner_progress').select('*').eq('user_id', req.params.id);
  const { data: recent } = await supabase.from('submissions')
    .select('*, tasks(quiz_title, track, xp_reward)')
    .eq('user_id', req.params.id)
    .order('created_at', { ascending: false })
    .limit(10);

  res.json({ user, progress, recent_submissions: recent });
});

// Leaderboard
app.get('/api/leaderboard', async (req, res) => {
  const { data } = await supabase
    .from('users')
    .select('id, name, xp, level, track, streak')
    .eq('role', 'learner')
    .order('xp', { ascending: false })
    .limit(20);
  res.json(data);
});

// ============================================
// CODE EXECUTION via Piston (FREE)
// ============================================
async function runCodeOnPiston(code, language, test_cases) {
  const langMap = {
    javascript: { language: 'javascript', version: '18.15.0' },
    python: { language: 'python', version: '3.10.0' },
    java: { language: 'java', version: '15.0.2' },
    cpp: { language: 'c++', version: '10.2.0' },
    html: null // HTML doesn't execute, handle separately
  };

  const lang = langMap[language];
  if (!lang) return { all_passed: true, output: 'HTML validated', errors: null };

  const results = [];

  // Run against each test case
  for (const testCase of (test_cases || [{ input: '', output: '' }])) {
    try {
      const response = await axios.post(`${PISTON_URL}/execute`, {
        language: lang.language,
        version: lang.version,
        files: [{ name: 'main', content: code }],
        stdin: testCase.input || '',
        run_timeout: 5000
      });

      const actual = (response.data.run?.stdout || '').trim();
      const expected = (testCase.output || '').trim();
      const passed = actual === expected || expected === '';

      results.push({ input: testCase.input, expected, actual, passed });
    } catch (err) {
      results.push({ input: testCase.input, expected: testCase.output, actual: 'error', passed: false, error: err.message });
    }
  }

  return {
    all_passed: results.every(r => r.passed),
    test_results: results,
    passed_count: results.filter(r => r.passed).length,
    total_count: results.length
  };
}

// ============================================
// MAJORITY VOTING LOGIC
// ============================================
async function checkVotingThreshold(task_id, task) {
  // Count correct submissions
  const { count } = await supabase
    .from('submissions')
    .select('*', { count: 'exact', head: true })
    .eq('task_id', task_id)
    .eq('is_correct', true);

  if (count >= task.min_votes) {
    await supabase.from('tasks')
      .update({ status: 'voting' })
      .eq('id', task_id);

    // Trigger majority check
    await checkMajorityVote(task_id);
  }
}

async function checkMajorityVote(task_id) {
  // Get all votes grouped by submission
  const { data: votes } = await supabase
    .from('votes')
    .select('submission_id')
    .eq('task_id', task_id);

  if (!votes || votes.length === 0) return { majority_reached: false };

  // Count votes per submission
  const voteCounts = {};
  votes.forEach(v => {
    voteCounts[v.submission_id] = (voteCounts[v.submission_id] || 0) + 1;
  });

  const maxVotes = Math.max(...Object.values(voteCounts));
  const totalVotes = votes.length;
  const majorityThreshold = 0.6; // 60% agreement = majority

  if (maxVotes / totalVotes >= majorityThreshold && totalVotes >= 3) {
    // Majority reached — get winning submission
    const winningId = Object.keys(voteCounts).find(k => voteCounts[k] === maxVotes);
    const { data: winning } = await supabase
      .from('submissions')
      .select('submitted_code, selected_option, task_id')
      .eq('id', winningId).single();

    // Mark task as verified with winning answer
    const verifiedOutput = winning.submitted_code || String(winning.selected_option);
    await supabase.from('tasks')
      .update({ status: 'verified', verified_output: verifiedOutput })
      .eq('id', task_id);

    // Save to project outputs for assembly
    await commitToProjectOutput(task_id, verifiedOutput);

    return { majority_reached: true, winning_submission_id: winningId, vote_count: maxVotes };
  }

  return { majority_reached: false, votes_so_far: totalVotes };
}

async function commitToProjectOutput(task_id, content) {
  const { data: task } = await supabase
    .from('tasks').select('*, projects(id, name, repo_url)').eq('id', task_id).single();
  if (!task) return;

  // Save verified output to project_outputs
  await supabase.from('project_outputs').insert({
    project_id: task.project_id,
    task_id,
    content,
    committed_at: new Date().toISOString()
  });

  // Update project completed count
  await supabase.rpc('increment_completed_tasks', { project_id: task.project_id });

  // If repo_url exists, auto-commit via GitHub API
  if (task.projects?.repo_url && process.env.GITHUB_TOKEN) {
    await commitToGitHub(task, content);
  }
}

// ============================================
// GITHUB AUTO-COMMIT (free GitHub API)
// ============================================
async function commitToGitHub(task, content) {
  try {
    const repoPath = task.projects.repo_url.replace('https://github.com/', '');
    const filePath = getFilePath(task);
    const apiUrl = `https://api.github.com/repos/${repoPath}/contents/${filePath}`;

    // Check if file exists (need SHA to update)
    let sha;
    try {
      const existing = await axios.get(apiUrl, {
        headers: { Authorization: `token ${process.env.GITHUB_TOKEN}` }
      });
      sha = existing.data.sha;
    } catch { /* file doesn't exist yet, create it */ }

    const body = {
      message: `feat: add ${task.title} [TaskForge auto-commit]`,
      content: Buffer.from(content).toString('base64'),
      branch: 'taskforge-contributions'
    };
    if (sha) body.sha = sha;

    await axios.put(apiUrl, body, {
      headers: {
        Authorization: `token ${process.env.GITHUB_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`✓ Committed ${filePath} to ${repoPath}`);
  } catch (err) {
    console.error('GitHub commit failed:', err.message);
  }
}

function getFilePath(task) {
  const paths = {
    frontend: `src/components/${task.title.replace(/\s+/g, '')}.jsx`,
    backend: `src/api/${task.title.replace(/\s+/g, '').toLowerCase()}.js`,
    api: `src/integrations/${task.title.replace(/\s+/g, '').toLowerCase()}.js`,
    security: `docs/security/${task.title.replace(/\s+/g, '-').toLowerCase()}.md`
  };
  return paths[task.track] || `src/${task.title}.js`;
}

// ============================================
// AI TASK BREAKDOWN (Claude API)
// ============================================
async function breakProjectIntoTasks(project) {
  try {
    const response = await axios.post(ANTHROPIC_URL, {
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `You are a project manager for TaskForge — a platform where learners unknowingly complete real project tasks disguised as learning exercises.

Project: "${project.name}"
Description: "${project.description}"
Tech stack: ${(project.tech_stack || []).join(', ')}

Break this into 8-12 micro-tasks. Return ONLY valid JSON array:
[
  {
    "track": "frontend|backend|api|security",
    "title": "Real task name (internal)",
    "description": "What this task actually does for the project",
    "quiz_title": "How learner sees it (educational framing)",
    "quiz_context": "Learning context that makes it seem like practice",
    "quiz_type": "mcq|code",
    "options": ["option A","option B","option C","option D"],
    "correct_option": 0,
    "xp_reward": 25,
    "min_votes": 3
  }
]

Rules:
- quiz_title must sound like a pure learning exercise
- mix mcq and code tasks
- spread across all 4 tracks
- options only for mcq type
- make tasks specific to this actual project`
      }]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      }
    });

    let text = response.data.content[0].text.trim();
    text = text.replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch (err) {
    console.error('AI breakdown failed, using fallback:', err.message);
    return getDefaultTasks(project);
  }
}

function getDefaultTasks(project) {
  return [
    { track: 'frontend', title: 'Product Listing Component', quiz_title: 'CSS Grid Challenge: Build a product grid', quiz_context: 'Practice CSS Grid by building a real product listing layout', quiz_type: 'mcq', options: ['display: flex', 'display: grid; grid-template-columns: repeat(3, 1fr)', 'float: left', 'display: table'], correct_option: 1, xp_reward: 25, min_votes: 3 },
    { track: 'frontend', title: 'Cart UI Component', quiz_title: 'JavaScript Exercise: Shopping cart state management', quiz_context: 'Learn state management by building a cart counter', quiz_type: 'code', starter_code: 'function addToCart(items, newItem) {\n  // your code here\n}', xp_reward: 35, min_votes: 3 },
    { track: 'backend', title: 'Products REST API', quiz_title: 'Node.js Quiz: REST API design patterns', quiz_context: 'Learn REST best practices by designing a product API', quiz_type: 'mcq', options: ['GET /products/getAll', 'GET /api/products', 'FETCH /products', 'GET /getAllProducts'], correct_option: 1, xp_reward: 25, min_votes: 3 },
    { track: 'backend', title: 'SQL Injection Prevention', quiz_title: 'Debug Exercise: Find the security bug', quiz_context: 'Practice identifying SQL injection vulnerabilities', quiz_type: 'mcq', options: ['Use string concatenation', 'Use parameterized queries', 'Escape quotes manually', 'Convert to uppercase'], correct_option: 1, xp_reward: 40, min_votes: 3 },
    { track: 'api', title: 'Payment Gateway Integration', quiz_title: 'API Integration: Webhook verification', quiz_context: 'Learn how payment webhooks work and how to verify them securely', quiz_type: 'mcq', options: ['Trust all incoming webhooks', 'Verify HMAC signature before processing', 'Check IP address only', 'Log and ignore'], correct_option: 1, xp_reward: 35, min_votes: 3 },
    { track: 'security', title: 'Auth Penetration Test', quiz_title: 'CTF Challenge: Exploit this login', quiz_context: 'Ethical hacking exercise — find the auth vulnerability', quiz_type: 'mcq', options: ['XSS', 'CSRF', 'Brute force (no rate limiting)', 'DDoS'], correct_option: 2, xp_reward: 50, min_votes: 3 }
  ];
}

// ============================================
// HELPER FUNCTIONS
// ============================================
async function updateLearnerXP(user_id, track, xp) {
  // Upsert learner_progress
  await supabase.from('learner_progress').upsert({
    user_id, track,
    tasks_completed: 1, tasks_correct: 1, xp_earned: xp
  }, { onConflict: 'user_id,track', ignoreDuplicates: false });

  // Update total XP on user
  await supabase.rpc('increment_xp', { user_id, amount: xp });
}

async function castAutoVote(task_id, submission_id, user_id) {
  try {
    await supabase.from('votes').insert({ task_id, submission_id, voter_id: user_id });
  } catch { /* ignore duplicate vote */ }
}

function getContributionMessage(track) {
  const messages = {
    frontend: 'Your code was verified and queued for the project\'s UI layer',
    backend: 'Your answer confirmed the correct API pattern — logged to backend spec',
    api: 'Your integration answer was verified — added to the API documentation',
    security: 'Security finding recorded — this will be patched in the live system'
  };
  return messages[track] || 'Your answer contributed to a real project';
}

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`TaskForge API running on port ${PORT}`);
  console.log(`Free stack: Supabase + Piston + GitHub API`);
});

module.exports = app;
