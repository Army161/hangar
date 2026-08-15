/**
 * The demo script. This is the file to edit.
 *
 * Each scene pairs a line of narration with what the app should be doing while
 * it is spoken. The build measures the real length of each rendered audio clip
 * and holds the matching shot for exactly that long, so the two stay in sync
 * without anyone tuning timings by hand — and stay in sync after you reword a
 * line, which is the part that usually rots.
 *
 * `action` receives the Playwright page. Keep it to navigation and clicks;
 * anything slow belongs in `pre`, which runs before the clock starts.
 */

const TAB = (name) => async (page) => {
  await page.click(`.tab[data-view="${name}"]`);
  await page.waitForTimeout(400);
};

module.exports = {
  meta: {
    title: 'Hangar — why is this running?',
    url: 'http://localhost:7420',
    width: 1440,
    height: 900,
    // Held after the last word so the video does not cut on a syllable.
    tailMs: 1200,
  },

  scenes: [
    {
      id: 'intro',
      say: 'This is Hangar. Task Manager tells you node dot e x e, times seventy six. '
         + 'Hangar tells you which seventy six, who started them, and what breaks if you stop them.',
      action: async (page) => { await page.waitForTimeout(600); },
    },
    {
      id: 'owners',
      say: 'The Owners view groups every process by the real thing that owns it. '
         + 'Not a wall of identical executable names, but the agent, the project, or the app underneath. '
         + 'Memory is charged to the top of each tree, so a parent and its children are never counted twice.',
      action: TAB('owners'),
    },
    {
      id: 'owners-detail',
      say: 'Click any row and you get the full command line, and a trace of where it came from.',
      action: async (page) => {
        const row = page.locator('.rows .row').first();
        if (await row.count()) { await row.click(); await page.waitForTimeout(500); }
      },
    },
    {
      id: 'ports',
      say: 'The Port wall shows every listening port on the machine, probed for h t t p '
         + 'and labelled with its page title. This is where you find the local app you '
         + 'started three weeks ago and forgot about.',
      action: TAB('ports'),
    },
    {
      id: 'origins',
      say: 'Origins answers the harder question: what is configured to start itself. '
         + 'Startup folder entries, registry run keys, scheduled tasks and services, oldest first, '
         + 'each with the date it was added and how much that date can be trusted.',
      action: TAB('origins'),
    },
    {
      id: 'fanout',
      say: 'Fan-out shows the same thing running more than once, and what collapsing it would give back.',
      action: TAB('fanout'),
    },
    {
      id: 'graveyard',
      say: 'The Graveyard ranks projects that stopped being touched, by what reviving or removing them would reclaim.',
      action: TAB('graveyard'),
    },
    {
      id: 'safety',
      say: 'Now the important part. Hangar can stop things, and every kill passes three gates. '
         + 'A dry run that shows exactly what would die and what the guard refuses. '
         + 'A typed confirmation phrase, single use, expiring after five minutes. '
         + 'And a re-evaluation against a fresh process table, because process i ds get recycled.',
      action: TAB('manifests'),
    },
    {
      id: 'manifests',
      say: 'Before anything dies, a restore manifest is written to disk. If that manifest cannot be written, nothing dies. '
         + 'Every park is listed here with a one click restore.',
      action: async (page) => { await page.waitForTimeout(400); },
    },
    {
      id: 'settings',
      say: 'Settings holds your own never-kill list, how often each collector runs, '
         + 'and optional connectors. Agent endpoints are restricted to loopback, '
         + 'because the agent dials them itself.',
      action: TAB('settings'),
    },
    {
      id: 'close',
      say: 'Hangar runs entirely on your machine. The desktop build has no network listener at all. '
         + 'Nothing is ever deleted, and nothing leaves the box. '
         + 'Windows, mac o s and Linux builds are on the releases page.',
      action: TAB('owners'),
    },
  ],
};
