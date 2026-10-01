const NHL_BASE = "https://api-web.nhle.com/v1";

exports.handler = async function () {
  try {
    const now = new Date();

    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);

    const twoDaysAgo = new Date(now);
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

    const formatDate = (date) => date.toISOString().split("T")[0];

    const yesterdayStr = formatDate(yesterday);
    const twoDaysAgoStr = formatDate(twoDaysAgo);

    async function getJSON(url) {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status} ${url}`);
      }

      return response.json();
    }

    // Fetch the main datasets in parallel
    const [
      scores,
      standingsNow,
      standingsPrevious,
      schedule
    ] = await Promise.all([
      getJSON(`${NHL_BASE}/score/${yesterdayStr}`),
      getJSON(`${NHL_BASE}/standings/now`),
      getJSON(`${NHL_BASE}/standings/${twoDaysAgoStr}`),
      getJSON(`${NHL_BASE}/schedule/now`)
    ]);

    // ----------------------------------------------------
    // STANDINGS LOOKUPS
    // ----------------------------------------------------

    const standingsByTeam = {};

    for (const team of standingsNow.standings || []) {
      const abbrev =
        team.teamAbbrev?.default ||
        team.teamAbbrev ||
        "";

      standingsByTeam[abbrev] = team;
    }

    const previousRanks = {};

    for (const team of standingsPrevious.standings || []) {
      const abbrev =
        team.teamAbbrev?.default ||
        team.teamAbbrev ||
        "";

      previousRanks[abbrev] =
        team.leagueSequence ??
        team.conferenceSequence ??
        null;
    }

    // ----------------------------------------------------
    // YESTERDAY'S GAMES
    // ----------------------------------------------------

    const completedGames = (scores.games || []).filter(game =>
      ["FINAL", "OFF"].includes(game.gameState)
    );

    const games = await Promise.all(
      completedGames.map(async (game) => {
        const awayAbbrev = game.awayTeam?.abbrev || "";
        const homeAbbrev = game.homeTeam?.abbrev || "";

        const awayStanding = standingsByTeam[awayAbbrev];
        const homeStanding = standingsByTeam[homeAbbrev];

        let topPerformer = null;

        try {
          const boxscore = await getJSON(
            `${NHL_BASE}/gamecenter/${game.id}/boxscore`
          );

          const allPlayers = [];

          function getPlayerName(player) {
            const first =
              player.firstName?.default ||
              player.firstName ||
              "";

            const last =
              player.lastName?.default ||
              player.lastName ||
              "";

            const fullName = `${first} ${last}`.trim();

            if (fullName) return fullName;

            if (player.name?.default) {
              return player.name.default;
            }

            if (typeof player.name === "string") {
              return player.name;
            }

            return "Unknown";
          }

          function collectPlayers(teamStats, teamAbbrev) {
            if (!teamStats) return;

            const groups = [
              ...(teamStats.forwards || []),
              ...(teamStats.defense || [])
            ];

            for (const player of groups) {
              const goals = player.goals ?? 0;
              const assists = player.assists ?? 0;
              const points = player.points ?? (goals + assists);

              allPlayers.push({
                name: getPlayerName(player),
                team: teamAbbrev,
                goals,
                assists,
                points
              });
            }
          }

          collectPlayers(
            boxscore.playerByGameStats?.awayTeam,
            awayAbbrev
          );

          collectPlayers(
            boxscore.playerByGameStats?.homeTeam,
            homeAbbrev
          );

          allPlayers.sort((a, b) => {
            if (b.points !== a.points) {
              return b.points - a.points;
            }

            if (b.goals !== a.goals) {
              return b.goals - a.goals;
            }

            return b.assists - a.assists;
          });

          topPerformer = allPlayers[0] || null;

        } catch (error) {
          console.log(
            `Could not load boxscore for ${game.id}`,
            error.message
          );
        }

        function streakInfo(standing) {
          if (!standing) {
            return {
              code: "",
              count: 0,
              emoji: ""
            };
          }

          const code =
            standing.streakCode ||
            standing.streak?.code ||
            "";

          const count =
            standing.streakCount ||
            standing.streak?.count ||
            0;

          const normalized = String(code).toUpperCase();

          return {
            code: normalized,
            count,
            emoji:
              normalized.startsWith("W")
                ? "🔥"
                : normalized.startsWith("L")
                ? "❄️"
                : "•"
          };
        }

        const awayStreak = streakInfo(awayStanding);
        const homeStreak = streakInfo(homeStanding);

        return {
          id: game.id,

          away: {
            abbrev: awayAbbrev,
            score: game.awayTeam?.score ?? 0,
            streak: awayStreak
          },

          home: {
            abbrev: homeAbbrev,
            score: game.homeTeam?.score ?? 0,
            streak: homeStreak
          },

          topPerformer,

          periodType:
            game.gameOutcome?.lastPeriodType || ""
        };
      })
    );

    // ----------------------------------------------------
    // FULL STANDINGS
    // ----------------------------------------------------

    const standings = (standingsNow.standings || []).map(team => {
      const abbrev =
        team.teamAbbrev?.default ||
        team.teamAbbrev ||
        "";

      const currentRank =
        team.leagueSequence ??
        team.conferenceSequence ??
        null;

      const oldRank = previousRanks[abbrev];

      let movement = 0;

      if (
        typeof currentRank === "number" &&
        typeof oldRank === "number"
      ) {
        movement = oldRank - currentRank;
      }

      return {
        abbrev,

        name:
          team.teamName?.default ||
          team.teamCommonName?.default ||
          abbrev,

        conference:
          team.conferenceName ||
          "",

        division:
          team.divisionName ||
          "",

        wins: team.wins ?? 0,
        losses: team.losses ?? 0,
        otLosses: team.otLosses ?? 0,
        points: team.points ?? 0,

        conferenceRank:
          team.conferenceSequence ?? null,

        divisionRank:
          team.divisionSequence ?? null,

        leagueRank:
          team.leagueSequence ?? null,

        movement
      };
    });

    // ----------------------------------------------------
    // UPCOMING GAMES
    // ----------------------------------------------------

    const upcoming = [];

    for (const week of schedule.gameWeek || []) {
      for (const game of week.games || []) {
        if (
          ["FUT", "PRE"].includes(game.gameState)
        ) {
          upcoming.push({
            id: game.id,
            startTimeUTC: game.startTimeUTC,

            away:
              game.awayTeam?.abbrev || "",

            home:
              game.homeTeam?.abbrev || ""
          });
        }
      }
    }

    upcoming.sort(
      (a, b) =>
        new Date(a.startTimeUTC) -
        new Date(b.startTimeUTC)
    );

    const nextGames = upcoming.slice(0, 8);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300"
      },
      body: JSON.stringify({
        date: yesterdayStr,
        games,
        standings,
        upcoming: nextGames
      })
    };

  } catch (error) {
    console.error(error);

    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        error: error.message || "Something went wrong"
      })
    };
  }
};
