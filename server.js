/**
 * Serveur du Prédicteur Coupe du Monde 2026
 * ===========================================
 * Ce serveur fait trois choses :
 *  1. Il sert l'app elle-même (HTML, manifeste PWA, icônes, service worker)
 *     depuis le dossier "public" — c'est ce qui permet d'installer l'app
 *     sur un téléphone comme une vraie application.
 *  2. Il appelle l'API-Football à ta place (ta clé reste secrète côté
 *     serveur, jamais visible dans le navigateur de l'utilisateur).
 *  3. Il garde les résultats en mémoire pendant 10 minutes (cache) pour
 *     éviter de dépasser ton quota d'appels API si plusieurs personnes
 *     ouvrent l'app en même temps.
 */

const path = require("path");
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors()); // autorise les appels venant d'autres domaines (utile en développement)

// Sert tous les fichiers du dossier "public" (HTML, manifest.json, icônes,
// sw.js) à la racine du site. C'est ce qui permet à l'app d'être hébergée et
// donc installable depuis cette même adresse Render.
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY; // définie sur Render, jamais en dur ici
const BASE_URL = "https://v3.football.api-sports.io";

// Coupe du Monde 2026 = league id 1 dans API-Football, saison 2026
const LEAGUE_ID = 1;
const SEASON = 2026;

// ---- Cache simple en mémoire ----
let cache = { data: null, fetchedAt: 0 };
const CACHE_DURATION_MS = 10 * 60 * 1000; // 10 minutes

async function apiFootballGet(path, params) {
  const url = new URL(BASE_URL + path);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const resp = await fetch(url, {
    headers: { "x-apisports-key": API_KEY },
  });
  if (!resp.ok) {
    throw new Error(`Appel API-Football échoué (${resp.status})`);
  }
  return resp.json();
}

/**
 * Récupère les prochains matchs de la Coupe du Monde 2026 qui n'ont pas
 * encore commencé (statut NS = Not Started). On filtre par statut plutôt que
 * par seul "next" pour être certain qu'aucun match déjà débuté ne s'affiche,
 * même si l'API a un léger délai à passer un match en "en cours".
 */
async function fetchUpcomingFixtures() {
  // Deux appels séparés car l'API ne supporte pas "next" avec des statuts
  // multiples : un pour les matchs à venir (NS = Not Started), un pour les
  // matchs en cours (1H, HT, 2H, ET). On fusionne les résultats.
  const [upcomingResp, liveResp] = await Promise.all([
    apiFootballGet("/fixtures", { league: LEAGUE_ID, season: SEASON, next: 100, status: "NS" }),
    apiFootballGet("/fixtures", { league: LEAGUE_ID, season: SEASON, status: "1H-HT-2H-ET" }),
  ]);

  const upcoming = upcomingResp.response || [];
  const live = liveResp.response || [];

  // Dédoublonnage par fixtureId au cas où un match apparaîtrait dans les deux
  const seen = new Set();
  const fixtures = [...live, ...upcoming].filter((f) => {
    if (seen.has(f.fixture.id)) return false;
    seen.add(f.fixture.id);
    return true;
  });

  const now = Date.now();

  const enriched = fixtures
    .filter((f) => {
      const status = f.fixture.status?.short;
      const isLive = ['1H', 'HT', '2H', 'ET'].includes(status);
      // Pour les matchs en cours, on ne filtre pas par date (leur date est
      // dans le passé par définition). Pour les matchs à venir, on vérifie
      // quand même que la date est dans le futur (garde-fou).
      return isLive || new Date(f.fixture.date).getTime() > now;
    })
    .map((f) => {
      const homeId = f.teams.home.id;
      const awayId = f.teams.away.id;

      return {
        fixtureId: f.fixture.id,
        date: f.fixture.date,
        venue: f.fixture.venue?.name || null,
        round: f.league.round,
        status: f.fixture.status?.short || null,
        home: {
          id: homeId,
          name: f.teams.home.name,
          logo: f.teams.home.logo,
        },
        away: {
          id: awayId,
          name: f.teams.away.name,
          logo: f.teams.away.logo,
        },
      };
    });

  return enriched;
}

/**
 * Récupère les matchs déjà joués de la Coupe du Monde 2026, avec le score
 * final. Une seule requête couvre tout le tournoi (filtrée par statut "FT" =
 * Full Time, donc terminé), pas besoin d'un appel par match.
 */
async function fetchFinishedFixtures() {
  const fixturesResp = await apiFootballGet("/fixtures", {
    league: LEAGUE_ID,
    season: SEASON,
    status: "FT",
  });

  const fixtures = fixturesResp.response || [];

  return fixtures.map((f) => ({
    fixtureId: f.fixture.id,
    date: f.fixture.date,
    round: f.league.round,
    home: { id: f.teams.home.id, name: f.teams.home.name },
    away: { id: f.teams.away.id, name: f.teams.away.name },
    goals: { home: f.goals.home, away: f.goals.away },
  }));
}

// ---- Cache pour les prédictions par fixture (clé = fixtureId) ----
const predictionsCache = new Map();

/**
 * Récupère le pronostic propre de l'API pour un match précis : vainqueur
 * prédit, probabilités, comparaison de force d'attaque/défense, et historique
 * des confrontations directes (head-to-head) entre les deux équipes.
 */
app.get("/api/predictions/:fixtureId", async (req, res) => {
  const { fixtureId } = req.params;
  try {
    const now = Date.now();
    const cached = predictionsCache.get(fixtureId);
    if (cached && now - cached.fetchedAt < CACHE_DURATION_MS) {
      return res.json({ cached: true, prediction: cached.data });
    }

    const raw = await apiFootballGet("/predictions", { fixture: fixtureId });
    const prediction = raw.response?.[0] || null;
    predictionsCache.set(fixtureId, { data: prediction, fetchedAt: now });
    res.json({ cached: false, prediction });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Impossible de récupérer le pronostic pour ce match." });
  }
});

// ---- Cache pour les statistiques détaillées par fixture ----
const statsCache = new Map();

/**
 * Récupère les statistiques détaillées (tirs, possession, corners, fautes,
 * cartons) pour un match précis, une équipe par entrée. Ne fonctionne que
 * pour les matchs déjà en cours ou terminés — un match pas encore commencé
 * renvoie une liste vide, ce qui est normal et pas une erreur.
 */
app.get("/api/statistics/:fixtureId", async (req, res) => {
  const { fixtureId } = req.params;
  try {
    const now = Date.now();
    const cached = statsCache.get(fixtureId);
    if (cached && now - cached.fetchedAt < CACHE_DURATION_MS) {
      return res.json({ cached: true, statistics: cached.data });
    }

    const raw = await apiFootballGet("/fixtures/statistics", { fixture: fixtureId });
    const statistics = raw.response || [];
    statsCache.set(fixtureId, { data: statistics, fetchedAt: now });
    res.json({ cached: false, statistics });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Impossible de récupérer les statistiques pour ce match." });
  }
});

// ---- Cache pour la moyenne de stats récentes par équipe (clé = teamId) ----
const avgStatsCache = new Map();

/**
 * Calcule la moyenne de possession, tirs et corners sur les 5 derniers
 * matchs joués par une équipe (toutes compétitions). Nécessite plusieurs
 * appels en cascade : 1 pour la liste des matchs + jusqu'à 5 pour leurs
 * statistiques. Les matchs sans statistiques disponibles sont ignorés plutôt
 * que de fausser la moyenne avec des zéros.
 */
async function fetchTeamAverageStats(teamId) {
  const recentResp = await apiFootballGet("/fixtures", { team: teamId, last: 5 });
  const recentFixtures = recentResp.response || [];

  const perMatchStats = await Promise.all(
    recentFixtures.map(async (f) => {
      try {
        const statsResp = await apiFootballGet("/fixtures/statistics", { fixture: f.fixture.id });
        const teamEntry = (statsResp.response || []).find((s) => s.team.id === Number(teamId));
        if (!teamEntry) return null;

        const getVal = (type) => {
          const found = teamEntry.statistics.find((s) => s.type === type);
          if (!found || found.value === null) return null;
          if (typeof found.value === "string" && found.value.includes("%")) {
            return parseFloat(found.value);
          }
          return Number(found.value);
        };

        return {
          possession: getVal("Ball Possession"),
          totalShots: getVal("Total Shots"),
          shotsOnGoal: getVal("Shots on Goal"),
          corners: getVal("Corner Kicks"),
        };
      } catch {
        return null; // un match sans stats ne doit pas faire échouer tout le calcul
      }
    })
  );

  const valid = perMatchStats.filter((s) => s !== null);
  const average = (key) => {
    const vals = valid.map((s) => s[key]).filter((v) => v !== null && v !== undefined);
    if (vals.length === 0) return null;
    return vals.reduce((sum, v) => sum + v, 0) / vals.length;
  };

  return {
    matchesUsed: valid.length,
    possession: average("possession"),
    totalShots: average("totalShots"),
    shotsOnGoal: average("shotsOnGoal"),
    corners: average("corners"),
  };
}

app.get("/api/team-avg-stats/:teamId", async (req, res) => {
  const { teamId } = req.params;
  try {
    const now = Date.now();
    const cached = avgStatsCache.get(teamId);
    // Cache plus long (1h) car ça représente beaucoup d'appels API d'un coup.
    if (cached && now - cached.fetchedAt < 60 * 60 * 1000) {
      return res.json({ cached: true, averageStats: cached.data });
    }

    const averageStats = await fetchTeamAverageStats(teamId);
    avgStatsCache.set(teamId, { data: averageStats, fetchedAt: now });
    res.json({ cached: false, averageStats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Impossible de calculer la moyenne pour cette équipe." });
  }
});

app.get("/api/fixtures", async (req, res) => {
  try {
    const now = Date.now();
    if (cache.data && now - cache.fetchedAt < CACHE_DURATION_MS) {
      return res.json({ cached: true, fixtures: cache.data });
    }

    const fixtures = await fetchUpcomingFixtures();
    cache = { data: fixtures, fetchedAt: now };
    res.json({ cached: false, fixtures });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Impossible de récupérer les matchs pour le moment." });
  }
});

// ---- Cache séparé pour les résultats déjà joués ----
let resultsCache = { data: null, fetchedAt: 0 };

app.get("/api/results", async (req, res) => {
  try {
    const now = Date.now();
    if (resultsCache.data && now - resultsCache.fetchedAt < CACHE_DURATION_MS) {
      return res.json({ cached: true, results: resultsCache.data });
    }

    const results = await fetchFinishedFixtures();
    resultsCache = { data: results, fetchedAt: now };
    res.json({ cached: false, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Impossible de récupérer les résultats pour le moment." });
  }
});

// Endpoint de santé, utile pour les services qui "réveillent" le serveur
// Endpoint de diagnostic : montre la réponse brute de l'API-Football, sans
// aucun filtrage, pour comprendre pourquoi /api/fixtures pourrait être vide
// (quota dépassé, accès à la saison restreint sur le plan gratuit, etc.)
app.get("/api/debug", async (req, res) => {
  try {
    const raw = await apiFootballGet("/fixtures", {
      league: LEAGUE_ID,
      season: SEASON,
      next: 5,
    });
    res.json(raw);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/healthz", (req, res) => res.send("ok"));

app.listen(PORT, () => {
  console.log(`Serveur du prédicteur démarré sur le port ${PORT}`);
});
