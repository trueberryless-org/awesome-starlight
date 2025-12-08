import fs from "fs/promises";
import path from "path";
import yaml from "js-yaml";

const DRY_RUN = process.argv.includes("--dry-run");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const SOURCES = {
  plugins:
    "https://raw.githubusercontent.com/withastro/starlight/refs/heads/main/docs/src/content/docs/resources/plugins.mdx",
  themes:
    "https://raw.githubusercontent.com/withastro/starlight/refs/heads/main/docs/src/content/docs/resources/themes.mdx",
  community:
    "https://raw.githubusercontent.com/withastro/starlight/refs/heads/main/docs/src/content/docs/resources/community-content.mdx",
  showcases:
    "https://raw.githubusercontent.com/withastro/starlight/refs/heads/main/docs/src/components/showcase-sites.astro",
};

const ASTRO_SHOWCASE_API =
  "https://api.github.com/repos/withastro/astro.build/contents/src/content/showcase";

class AwesomeStarlightUpdater {
  constructor() {
    this.officialData = {
      plugins: [],
      themes: [],
      tools: [],
      videos: [],
      articles: [],
      showcases: [],
    };

    this.processedUrls = new Set();
  }

  // --- Utilities ---

  async fetchText(url) {
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
    return response.text();
  }

  // --- Enhanced Link Validation ---

  /**
   * Router for validation: uses API for GitHub, standard fetch for others
   */
  async validateUrl(url) {
    if (!url) return false;

    // Normalize URL
    url = url.trim();

    // Avoid re-checking the same URL in one run
    if (this.processedUrls.has(url)) return true;
    this.processedUrls.add(url);

    if (url.includes("github.com")) {
      return this.checkGitHubRepo(url);
    }
    return this.checkGeneralUrl(url);
  }

  /**
   * Uses GitHub API to check if repo exists AND if it is a fork
   */
  async checkGitHubRepo(url) {
    try {
      // Extract owner and repo: github.com/owner/repo
      const match = url.match(/github\.com\/([^/]+)\/([^/#?]+)/);
      if (!match) return this.checkGeneralUrl(url); // Fallback if URL is weird

      const [, owner, repo] = match;
      const apiUrl = `https://api.github.com/repos/${owner}/${repo}`;

      const headers = {
        "User-Agent": "Awesome-Starlight-Updater",
        Accept: "application/vnd.github.v3+json",
      };
      if (GITHUB_TOKEN) headers["Authorization"] = `token ${GITHUB_TOKEN}`;

      const response = await fetch(apiUrl, { method: "GET", headers });

      if (response.status === 200) {
        const repoData = await response.json();

        // CHECK: Is it a fork?
        if (repoData.fork) {
          console.log(`   ✗ Filtered (Fork): ${owner}/${repo}`);
          return false;
        }

        return true;
      }

      if (response.status === 404) {
        // console.warn(`   ❌ GitHub Repo not found: ${owner}/${repo}`);
        return false;
      }

      // If rate limited (403), we assume it exists/is valid to be safe
      // (We can't check for forks without data, so we fail open to avoid accidental deletion)
      if (response.status === 403) return true;

      return false;
    } catch (e) {
      console.warn(`   ⚠️ Error checking GitHub ${url}: ${e.message}`);
      return false;
    }
  }

  /**
   * Standard HTTP check for non-GitHub links
   */
  async checkGeneralUrl(url) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000); // 6s timeout

      // 1. Try HEAD first
      let response = await fetch(url, {
        method: "HEAD",
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; AwesomeStarlightBot/1.0)",
        },
      });

      // 2. If Method Not Allowed (405) or similar, try GET
      if (response.status === 405 || response.status === 403) {
        response = await fetch(url, {
          method: "GET",
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; AwesomeStarlightBot/1.0)",
          },
        });
      }

      clearTimeout(timeoutId);

      // We consider it valid if status is 2xx.
      return response.ok;
    } catch (error) {
      // console.warn(`   ⚠️ Link unreachable: ${url}`);
      return false;
    }
  }

  // --- AI Logic ---

  async callGitHubModels(prompt) {
    if (!GITHUB_TOKEN)
      throw new Error("GITHUB_TOKEN is required for AI categorization");

    const response = await fetch(
      "https://models.inference.ai.azure.com/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GITHUB_TOKEN}`,
        },
        body: JSON.stringify({
          messages: [
            {
              role: "system",
              content:
                "You are a helpful assistant that categorizes documentation resources.",
            },
            { role: "user", content: prompt },
          ],
          model: "gpt-4o",
          temperature: 0.1,
          max_tokens: 4000,
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `GitHub Models API error (${response.status}): ${errorText}`,
      );
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }

  // --- Parsers ---

  parseLinkCard(content) {
    const linkCardRegex = /<LinkCard\s+([^>]+)\/>/g;
    const links = [];
    let match;
    while ((match = linkCardRegex.exec(content)) !== null) {
      const attrs = match[1];
      const href = attrs.match(/href=["']([^"']+)["']/)?.[1];
      const title = attrs.match(/title=["']([^"']+)["']/)?.[1];
      const desc = attrs.match(/description=["']([^"']+)["']/)?.[1];
      if (href && title && href.startsWith("http")) {
        links.push({
          title: title.trim(),
          url: href.trim(),
          description: desc?.trim() || "",
        });
      }
    }
    return links;
  }

  parseCardComponent(content) {
    const cardRegex = /<Card\s+([^>]+)\/>/g;
    const cards = [];
    let match;
    while ((match = cardRegex.exec(content)) !== null) {
      const attrs = match[1];
      const title = attrs.match(/title=["']([^"']+)["']/)?.[1];
      const href = attrs.match(/href=["']([^"']+)["']/)?.[1];
      if (title && href) {
        cards.push({ title: title.trim(), url: href.trim(), description: "" });
      }
    }
    return cards;
  }

  parseThemeGrid(content) {
    const themesMatch = content.match(
      /themes=\{?\[(\s*\{[\s\S]*?\}\s*,?\s*)+\]\}?/,
    );
    if (!themesMatch) return [];
    const themes = [];
    const themeRegex =
      /\{\s*title:\s*['"]([^'"]+)['"],\s*description:\s*['"]([^'"]*?)['"],\s*href:\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = themeRegex.exec(themesMatch[0])) !== null) {
      themes.push({
        title: match[1].trim(),
        description: match[2].trim(),
        url: match[3].trim(),
      });
    }
    return themes;
  }

  parseYouTubeGrid(content) {
    const videosMatch = content.match(
      /videos=\{?\[(\s*\{[\s\S]*?\}\s*,?\s*)+\]\}?/g,
    );
    if (!videosMatch) return [];
    const allVideos = [];
    for (const videoBlock of videosMatch) {
      const videoRegex =
        /\{\s*href:\s*['"]([^'"]+)['"],\s*title:\s*['"]([^'"]+)['"],\s*description:\s*['"]([^'"]*?)['"]/g;
      let match;
      while ((match = videoRegex.exec(videoBlock)) !== null) {
        allVideos.push({
          title: match[2].trim(),
          url: match[1].trim(),
          description: match[3].trim(),
        });
      }
    }
    return allVideos;
  }

  // --- Data Fetching ---

  async fetchOfficialSources() {
    console.log("📥 Step 1: Fetching official Starlight sources...");

    const [plugins, themes, communityData, showcases] = await Promise.all([
      this.fetchText(SOURCES.plugins).then((c) => this.parseLinkCard(c)),
      this.fetchText(SOURCES.themes).then((c) => this.parseThemeGrid(c)),
      this.fetchText(SOURCES.community).then(async (c) => ({
        articles: this.parseLinkCard(c),
        videos: this.parseYouTubeGrid(c),
      })),
      this.fetchText(SOURCES.showcases).then((c) => this.parseCardComponent(c)),
    ]);

    this.officialData = {
      plugins,
      themes,
      tools: [],
      videos: communityData.videos,
      articles: communityData.articles,
      showcases,
    };

    const count =
      plugins.length +
      themes.length +
      communityData.articles.length +
      communityData.videos.length +
      showcases.length;
    console.log(`   ✓ Fetched ${count} official items\n`);
  }

  async fetchAstroShowcase() {
    console.log("🔭 Step 1.5: Fetching Astro Showcase sites...");

    const headers = {
      "User-Agent": "Awesome-Starlight-Updater",
      Accept: "application/vnd.github.v3+json",
    };
    if (GITHUB_TOKEN) headers["Authorization"] = `token ${GITHUB_TOKEN}`;

    try {
      const response = await fetch(ASTRO_SHOWCASE_API, { headers });
      if (!response.ok) return [];

      const files = await response.json();
      const ymlFiles = files.filter((file) => file.name.endsWith(".yml"));

      const promises = ymlFiles.map(async (file) => {
        try {
          const contentRes = await fetch(file.download_url);
          const data = yaml.load(await contentRes.text());

          if (data.categories?.includes("starlight")) {
            const site = { title: data.title, url: data.url, description: "" };

            // VALIDATION CHECK (404s + Forks)
            const isValid = await this.validateUrl(site.url);
            if (!isValid) {
              console.log(`   ✗ Skipping invalid/fork/dead link: ${site.url}`);
              return null;
            }
            return site;
          }
        } catch (err) {}
        return null;
      });

      const results = await Promise.all(promises);
      const newSites = results.filter(Boolean);
      console.log(
        `   ✓ Found ${newSites.length} valid sites from Astro Showcase\n`,
      );
      return newSites;
    } catch (error) {
      console.error(`   ❌ Failed to fetch Astro showcases: ${error.message}`);
      return [];
    }
  }

  async searchNPM(query) {
    const response = await fetch(
      `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=250`,
    );
    if (!response.ok) throw new Error(`NPM search error`);
    return response.json();
  }

  async fetchSupplementaryNPM() {
    console.log("📦 Step 2: Fetching supplementary NPM packages...");
    const searches = ["starlight-", "@astrojs/starlight"];
    const allPackages = new Map();

    for (const query of searches) {
      const results = await this.searchNPM(query);
      for (const pkg of results.objects) {
        const name = pkg.package.name;
        // Only valid if name actually implies starlight or is scoped to it
        if (
          name.includes("starlight") ||
          name.startsWith("@astrojs/starlight")
        ) {
          allPackages.set(name, {
            name: pkg.package.name,
            description: pkg.package.description || "",
            homepage:
              pkg.package.links?.homepage || pkg.package.links?.repository,
            keywords: pkg.package.keywords || [],
          });
        }
      }
    }
    const packages = Array.from(allPackages.values());
    console.log(`   ✓ Found ${packages.length} raw NPM candidates\n`);
    return packages;
  }

  // --- Filtering & Categorization ---

  isDuplicate(newItem, officialItem) {
    // 1. Check URL Match
    const newUrl = (newItem.url || newItem.homepage || "")
      .toLowerCase()
      .replace(/\/$/, "");
    const officialUrl = (officialItem.url || "")
      .toLowerCase()
      .replace(/\/$/, "");
    if (newUrl && officialUrl && newUrl === officialUrl) return true;

    // 2. Check Repo Name Match
    const getRepo = (u) => u?.match(/github\.com\/[^/]+\/([^/#?]+)/)?.[1];
    const newRepo = getRepo(newItem.url || newItem.homepage);
    const officialRepo = getRepo(officialItem.url);
    if (newRepo && officialRepo && newRepo === officialRepo) return true;

    return false;
  }

  isSameTitle(newItem, officialItem) {
    const normalize = (t) => (t || "").trim().toLowerCase();
    return normalize(newItem.title) && normalize(newItem.title) === normalize(officialItem.title);
  }

  normalizeThemeKey(input) {
    return (input || "")
      .toLowerCase()
      .replace(/https?:\/\/(www\.)?/g, "")
      .replace(/starlight/g, "")
      .replace(/theme/g, "")
      .replace(/astro/g, "")
      .replace(/docs?/g, "")
      .replace(/[\s._-]+/g, "")
      .replace(/[^a-z0-9]/g, "")
      .trim();
  }

  extractRepoSlug(url) {
    return url?.match(/github\.com\/[^/]+\/([^/#?]+)/)?.[1] || "";
  }

  isLikelySameTheme(a, b) {
    // Compare by normalized titles and repo slugs to catch doc site vs repo URL cases
    const keyA = this.normalizeThemeKey(a.title);
    const keyB = this.normalizeThemeKey(b.title);
    const repoKeyA = this.normalizeThemeKey(
      this.extractRepoSlug(a.url || a.homepage || a.repo),
    );
    const repoKeyB = this.normalizeThemeKey(
      this.extractRepoSlug(b.url || b.homepage || b.repo),
    );

    const keysEqual = (x, y) => x && y && (x === y || x.includes(y) || y.includes(x));

    return (
      keysEqual(keyA, keyB) ||
      keysEqual(keyA, repoKeyB) ||
      keysEqual(keyB, repoKeyA) ||
      (repoKeyA && repoKeyB && keysEqual(repoKeyA, repoKeyB))
    );
  }

  async filterSupplementaryPackages(packages) {
    console.log("🔍 Step 3: Filtering & Validating packages...");

    const allOfficialItems = [
      ...this.officialData.plugins,
      ...this.officialData.themes,
      ...this.officialData.tools,
      ...this.officialData.videos,
      ...this.officialData.articles,
      ...this.officialData.showcases,
    ];

    const validatedPackages = [];

    for (const pkg of packages) {
      const pkgItem = { name: pkg.name, url: pkg.homepage };

      // 1. Deduplication
      if (allOfficialItems.some((off) => this.isDuplicate(pkgItem, off)))
        continue;

      // 2. TIGHTENED RELEVANCE CHECK
      const text =
        `${pkg.name} ${pkg.description} ${pkg.keywords.join(" ")}`.toLowerCase();

      const isOfficialScope = pkg.name.startsWith("@astrojs/");
      const mentionsAstro = text.includes("astro");
      const mentionsStarlight = text.includes("starlight");

      // Rule: If it's not in @astrojs scope, it MUST mention 'astro' explicitly.
      if (!isOfficialScope && !mentionsAstro) {
        // console.log(`   ✗ Filtered (Not Astro related): ${pkg.name}`);
        continue;
      }

      // Rule: Must verify 'starlight' relevance
      if (!mentionsStarlight && !pkg.name.includes("starlight")) {
        continue;
      }

      // 3. DEAD LINK & FORK CHECK
      const isValidLink = await this.validateUrl(pkg.homepage);
      if (!isValidLink) {
        // console.log(`   ✗ Filtered (Invalid/Fork/Dead): ${pkg.name}`);
        continue;
      }

      validatedPackages.push(pkg);
    }

    console.log(
      `   ✓ Kept ${validatedPackages.length} packages after strict filtering\n`,
    );
    return validatedPackages;
  }

  async categorizeSupplementary(packages) {
    console.log("🤖 Step 4: Categorizing packages with AI...");

    if (packages.length === 0) return { plugins: [], themes: [], tools: [] };

    const itemsList = packages
      .map(
        (pkg, i) => `${i}. ${pkg.name} | ${pkg.homepage} | ${pkg.description}`,
      )
      .join("\n");

    try {
      // PRECISE INSTRUCTIONS (DO NOT MODIFY)
      const prompt = `Categorize these Starlight-related NPM packages into ONE category each.

CATEGORIES:

**themes** - Visual themes/styling presets
- Pattern: "starlight-theme-*"
- Examples: "starlight-theme-rapide", "starlight-theme-galaxy"
- Must be for visual appearance only

**plugins** - Starlight plugins (injected via plugins array)
- For END USERS of Starlight
- Extends Starlight functionality
- Examples: "starlight-blog", "starlight-openapi", "starlight-image-zoom"

**tools** - Development tools (NOT injected as plugins)
- For DEVELOPERS/AUTHORS, not end users
- VS Code extensions, CLI tools, generators
- CRITICAL EXAMPLES:
  * "starlight-i18n" = tool (VS Code extension)
  * "@hideoo/starlight-plugin" = tool (generator)
  * "generator-starlight-plugin" = tool
  * "starlight-to-pdf" = tool (CLI)

RULES:
- If it's a VS Code extension → tool
- If it's for plugin authors → tool
- If it's a CLI utility → tool
- If name has "theme" → theme
- Otherwise → plugin

Packages (format: ID | name | url | description):
${itemsList}

Respond with ONLY a JSON object:
{
  "0": "plugin",
  "1": "theme",
  "2": "tool",
  ...
}`;

      const responseText = await this.callGitHubModels(prompt);
      const jsonMatch = responseText.match(/\{[\s\S]*?\}/);

      if (!jsonMatch) return this.fallbackCategorization(packages);

      const categorization = JSON.parse(jsonMatch[0]);
      const categorized = { plugins: [], themes: [], tools: [] };

      packages.forEach((pkg, i) => {
        const category =
          categorization[i] || categorization[String(i)] || "plugin";
        const item = {
          title: pkg.name,
          url: pkg.homepage,
          description: pkg.description,
        };

        if (category.includes("theme")) categorized.themes.push(item);
        else if (category.includes("tool")) categorized.tools.push(item);
        else categorized.plugins.push(item);
      });

      console.log(
        `   ✓ AI Categorized: ${categorized.plugins.length} plugins, ${categorized.themes.length} themes, ${categorized.tools.length} tools\n`,
      );
      return categorized;
    } catch (error) {
      console.error("   ✗ AI failed, using fallback:", error.message);
      return this.fallbackCategorization(packages);
    }
  }

  fallbackCategorization(packages) {
    const categorized = { plugins: [], themes: [], tools: [] };
    packages.forEach((pkg) => {
      const text = `${pkg.name} ${pkg.description}`.toLowerCase();
      const item = {
        title: pkg.name,
        url: pkg.homepage,
        description: pkg.description,
      };

      if (text.includes("theme") || pkg.name.includes("theme"))
        categorized.themes.push(item);
      else if (
        text.includes("vscode") ||
        text.includes("cli") ||
        text.includes("generator")
      )
        categorized.tools.push(item);
      else categorized.plugins.push(item);
    });
    return categorized;
  }

  // --- Execution & Formatting ---

  sortByPackageName(name) {
    name = (name || "").trim().toLowerCase();
    if (name.startsWith("@")) {
      const parts = name.split("/");
      return parts.length > 1 ? parts[1] : name;
    }
    return name;
  }

  async collectAllData() {
    console.log("🚀 Starting update process...\n");

    await this.fetchOfficialSources();

    // Merge Astro Showcases
    const astroShowcases = await this.fetchAstroShowcase();
    for (const site of astroShowcases) {
      if (
        !this.officialData.showcases.some((ex) => this.isDuplicate(site, ex))
      ) {
        this.officialData.showcases.push(site);
      }
    }

    // NPM processing
    const npmPackages = await this.fetchSupplementaryNPM();
    const filtered = await this.filterSupplementaryPackages(npmPackages);
    const categorized = await this.categorizeSupplementary(filtered);

    this.officialData.plugins.push(...categorized.plugins);
    // Avoid adding theme entries already present in official themes list (often demo URLs vs. GitHub repos)
    const newThemes = categorized.themes.filter(
      (theme) =>
        !this.officialData.themes.some(
          (existing) =>
            this.isDuplicate(theme, existing) ||
            this.isSameTitle(theme, existing) ||
            this.isLikelySameTheme(theme, existing),
        ),
    );
    this.officialData.themes.push(...newThemes);
    this.officialData.tools.push(...categorized.tools);

    // Sorting
    for (const key of Object.keys(this.officialData)) {
      this.officialData[key].sort((a, b) =>
        this.sortByPackageName(a.title).localeCompare(
          this.sortByPackageName(b.title),
        ),
      );
    }
  }

  formatMarkdownItem(item) {
    if (!item.title || !item.url) return null;
    return `- [${item.title}](${item.url})${item.description ? ` - ${item.description}` : ""}`;
  }

  generateMarkdown() {
    const sections = [];
    const addSection = (title, items, desc = "") => {
      if (items.length > 0) {
        const md = items
          .map((i) => this.formatMarkdownItem(i))
          .filter(Boolean)
          .join("\n");
        sections.push(`## ${title}\n\n${desc}${md}`);
      }
    };

    addSection("Plugins & Integrations", this.officialData.plugins);
    addSection(
      "Themes",
      this.officialData.themes,
      "Discover beautiful themes for your Starlight documentation:\n\n",
    );
    addSection(
      "Tools",
      this.officialData.tools,
      "Development tools and utilities for Starlight:\n\n",
    );
    addSection(
      "Showcases",
      this.officialData.showcases,
      "Real-world documentation sites built with Starlight:\n\n",
    );
    addSection(
      "Videos",
      this.officialData.videos,
      "Video tutorials and screencasts:\n\n",
    );
    addSection("Articles & Case Studies", this.officialData.articles);

    return sections.join("\n\n");
  }

  async updateReadme() {
    console.log("📝 Updating README.md...");
    const readmePath = path.join(process.cwd(), "README.md");
    let readme = await fs.readFile(readmePath, "utf-8");

    const startMarker = "<!-- AUTOMATED_CONTENT_START -->";
    const endMarker = "<!-- AUTOMATED_CONTENT_END -->";

    const startIndex = readme.indexOf(startMarker);
    const endIndex = readme.indexOf(endMarker);

    if (startIndex === -1 || endIndex === -1)
      throw new Error("Markers not found in README.md");

    const newContent = this.generateMarkdown();
    const before = readme.substring(0, startIndex + startMarker.length);
    const after = readme.substring(endIndex);

    readme = `${before}\n\n${newContent}\n\n${after}`;

    if (DRY_RUN) {
      console.log(
        "\n🏁 DRY RUN - Content preview:\n" +
          newContent.substring(0, 500) +
          "...\n",
      );
    } else {
      await fs.writeFile(readmePath, readme, "utf-8");
      console.log("✅ README.md updated successfully!");
    }
  }

  async run() {
    try {
      await this.collectAllData();
      await this.updateReadme();
      console.log("\n🎉 Update complete!\n");
    } catch (error) {
      console.error("\n❌ Error:", error.message);
      process.exit(1);
    }
  }
}

new AwesomeStarlightUpdater().run();
