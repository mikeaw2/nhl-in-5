const NHL_BASE = "https://api-web.nhle.com/v1";
const TIME_ZONE = "America/Chicago";

exports.handler = async function () {
  try {
    const now = new Date();

    // ----------------------------------------------------
    // CENTRAL-TIME DATE HELPERS
    // ----------------------------------------------------

    function getCentralDate(offsetDays = 0) {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).formatToParts(now);

      const year = Number(
        parts.find(part => part.type === "year").value
      );

      const month = Number(
        parts.find(part => part.type === "month").value
      );

      const day = Number(
        parts.find(part => part.type === "day").value
      );

      // Use UTC noon simply as a safe calendar-date calculator.
      const adjusted = new Date(
        Date.UTC(year, month - 1, day + offsetDays, 12)
      );

      return adjusted.toISOString().split("T")[0];
    }

    const todayStr = getCentralDate(0);
    const yesterdayStr = getCentralDate(-1);
    const twoDaysAgoStr = getCentralDate(-2);

    async function getJSON(url) {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(
          `Request failed: ${response.status} ${url}`
        );
      }

      return response.json();
    }

    const [
      todayScores,
      yesterdayScores,
      standingsNow,
      standingsPrevious,
      schedule
    ] = await Promise.all([
      getJSON(`${NHL_BASE}/score/${todayStr}`),
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
        team.divisionSequence ?? null;
    }

    // ----------------------------------------------------
    // HELPERS
    // ----------------------------------------------------

    function getTeamName(standing, fallbackAbbrev) {
      if (!standing) {
        return fallbackAbbrev;
      }

      return (
        standing.teamCommonName?.default ||
        standing.teamName?.default ||
        fallbackAbbrev
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

      const normalized =
        String(code).toUpperCase();

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

    async function getFullPlayerName(
      playerId,
      fallbackName
    ) {
      if (!playerId) {
        return fallbackName || "Unknown";
      }

      try {
        const profile = await getJSON(
          `${NHL_BASE}/player/${playerId}/landing`
        );

        const first =
          profile.firstName?.default ||
          profile.firstName ||
          "";

        const last =
          profile.lastName?.default ||
          profile.lastName ||
          "";

        const fullName =
          `${first} ${last}`.trim();

        if (fullName) {
          return fullName;
        }

        return fallbackName || "Unknown";

      } catch (error) {
        console.log(
          `Could not load player profile for ${playerId}`,
          error.message
        );

        return fallbackName || "Unknown";
      }
    }

    function getGameStatus(game) {
      const state = game.gameState || "";

      if (
        state === "LIVE" ||
        state === "CRIT"
      ) {
        const period =
          game.periodDescriptor?.number;

        const clock =
          game.clock?.timeRemaining;

        if (period && clock) {
          return `${period}${getOrdinal(period)} • ${clock}`;
        }

        if (period) {
          return `${period}${getOrdinal(period)} period`;
        }

        return "Live";
      }

      if (
        state === "FINAL" ||
        state === "OFF"
      ) {
        const periodType =
          game.gameOutcome?.lastPeriodType;

        if (periodType === "OT") {
          return "Final • OT";
        }

        if (periodType === "SO") {
          return "Final • SO";
        }

        return "Final";
      }

      return "Scheduled";
    }

    function getOrdinal(number) {
      if (number === 1) return "st";
      if (number === 2) return "nd";
      if (number === 3) return "rd";
      return "th";
    }

    // ----------------------------------------------------
    // TODAY / LIVE
    // ----------------------------------------------------

    const todayGames =
      (todayScores.games || []).map(game => {
        const awayAbbrev =
          game.awayTeam?.abbrev || "";

        const homeAbbrev =
          game.homeTeam?.abbrev || "";

        const awayStanding =
          standingsByTeam[awayAbbrev];

        const homeStanding =
          standingsByTeam[homeAbbrev];

        return {
          id: game.id,

          gameState:
            game.gameState || "",

          startTimeUTC:
            game.startTimeUTC || null,

          status:
            getGameStatus(game),

          away: {
            abbrev: awayAbbrev,
            name: getTeamName(
              awayStanding,
              awayAbbrev
            ),
            score:
              game.awayTeam?.score ?? null
          },

          home: {
            abbrev: homeAbbrev,
            name: getTeamName(
              homeStanding,
              homeAbbrev
            ),
            score:
              game.homeTeam?.score ?? null
          }
        };
      });

    // ----------------------------------------------------
    // YESTERDAY'S GAMES
    // ----------------------------------------------------

    const completedGames =
      (yesterdayScores.games || []).filter(game =>
        ["FINAL", "OFF"].includes(
          game.gameState
        )
      );

    const games = await Promise.all(
      completedGames.map(async game => {
        const awayAbbrev =
          game.awayTeam?.abbrev || "";

        const homeAbbrev =
          game.homeTeam?.abbrev || "";

        const awayStanding =
          standingsByTeam[awayAbbrev];

        const homeStanding =
          standingsByTeam[homeAbbrev];

        let topPerformer = null;

        try {
          const boxscore = await getJSON(
            `${NHL_BASE}/gamecenter/${game.id}/boxscore`
          );

          const allPlayers = [];

          function collectPlayers(
            teamStats,
            teamAbbrev
          ) {
            if (!teamStats) return;

            const groups = [
              ...(teamStats.forwards || []),
              ...(teamStats.defense || [])
            ];

            for (const player of groups) {
              const goals =
                player.goals ?? 0;

              const assists =
                player.assists ?? 0;

              const points =
                player.points ??
                (goals + assists);

              const fallbackName =
                player.name?.default ||
                player.name ||
                "Unknown";

              allPlayers.push({
                playerId:
                  player.playerId ?? null,

                fallbackName,

                team:
                  teamAbbrev,

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

          const bestPlayer =
            allPlayers[0] || null;

          if (bestPlayer) {
            const fullName =
              await getFullPlayerName(
                bestPlayer.playerId,
                bestPlayer.fallbackName
              );

            topPerformer = {
              name: fullName,
              team: bestPlayer.team,
              goals: bestPlayer.goals,
              assists: bestPlayer.assists,
              points: bestPlayer.points
            };
          }

        } catch (error) {
          console.log(
            `Could not load boxscore for ${game.id}`,
            error.message
          );
        }

        return {
          id: game.id,

          away: {
            abbrev: awayAbbrev,

            name:
              getTeamName(
                awayStanding,
                awayAbbrev
              ),

            score:
              game.awayTeam?.score ?? 0,

            streak:
              streakInfo(awayStanding)
          },

          home: {
            abbrev: homeAbbrev,

            name:
              getTeamName(
                homeStanding,
                homeAbbrev
              ),

            score:
              game.homeTeam?.score ?? 0,

            streak:
              streakInfo(homeStanding)
          },

          topPerformer,

          periodType:
            game.gameOutcome
              ?.lastPeriodType || ""
        };
      })
    );

    // ----------------------------------------------------
    // FULL STANDINGS
    // ----------------------------------------------------

    const standings =
      (standingsNow.standings || []).map(team => {
        const abbrev =
          team.teamAbbrev?.default ||
          team.teamAbbrev ||
          "";

        const currentRank =
          team.divisionSequence ?? null;

        const oldRank =
          previousRanks[abbrev];

        let movement = 0;

        if (
          typeof currentRank === "number" &&
          typeof oldRank === "number"
        ) {
          movement =
            oldRank - currentRank;
        }

        return {
          abbrev,

          name:
            team.teamCommonName?.default ||
            team.teamName?.default ||
            abbrev,

          conference:
            team.conferenceName || "",

          division:
            team.divisionName || "",

          wins:
            team.wins ?? 0,

          losses:
            team.losses ?? 0,

          otLosses:
            team.otLosses ?? 0,

          points:
            team.points ?? 0,

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
          ["FUT", "PRE"].includes(
            game.gameState
          )
        ) {
          const awayAbbrev =
            game.awayTeam?.abbrev || "";

          const homeAbbrev =
            game.homeTeam?.abbrev || "";

          const awayStanding =
            standingsByTeam[awayAbbrev];

          const homeStanding =
            standingsByTeam[homeAbbrev];

          upcoming.push({
            id:
              game.id,

            startTimeUTC:
              game.startTimeUTC,

            away:
              awayAbbrev,

            awayName:
              getTeamName(
                awayStanding,
                awayAbbrev
              ),

            home:
              homeAbbrev,

            homeName:
              getTeamName(
                homeStanding,
                homeAbbrev
              )
          });
        }
      }
    }

    upcoming.sort(
      (a, b) =>
        new Date(a.startTimeUTC) -
        new Date(b.startTimeUTC)
    );

    const nextGames =
      upcoming.slice(0, 8);

    return {
      statusCode: 200,

      headers: {
        "Content-Type":
          "application/json",

        "Cache-Control":
          "public, max-age=300"
      },

      body: JSON.stringify({
        today: todayStr,
        yesterday: yesterdayStr,
        todayGames,
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
        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({
        error:
          error.message ||
          "Something went wrong"
      })
    };
  }
};
