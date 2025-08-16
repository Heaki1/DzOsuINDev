const express = require('express');
const router = express.Router();
const { getRows, getRow } = require('../config/db');
const { cacheService } = require('../services/cache');
const { validateInput } = require('../config/security');

// Compare two players
router.get('/:username1/:username2', 
  validateInput({
    username1: { required: true, minLength: 2 },
    username2: { required: true, minLength: 2 }
  }),
  async (req, res) => {
    try {
      const { username1, username2 } = req.params;
      const cacheKey = cacheService.generateKey('compare', username1, username2);
      
      let data = await cacheService.get(cacheKey);
      
      if (!data) {
        const [player1, player2] = await Promise.all([
          getRow(`SELECT * FROM player_stats WHERE username ILIKE $1`, [`%${username1}%`]),
          getRow(`SELECT * FROM player_stats WHERE username ILIKE $1`, [`%${username2}%`])
        ]);
        
        if (!player1 || !player2) {
          return res.status(404).json({ 
            success: false, 
            error: 'One or both players not found' 
          });
        }
        
        const [skills1, skills2, scores1, scores2] = await Promise.all([
          getRows(`
            SELECT skill_type, AVG(skill_value) as avg_skill
            FROM skill_tracking 
            WHERE username ILIKE $1
            GROUP BY skill_type
          `, [`%${username1}%`]),
          getRows(`
            SELECT skill_type, AVG(skill_value) as avg_skill
            FROM skill_tracking 
            WHERE username ILIKE $1
            GROUP BY skill_type
          `, [`%${username2}%`]),
          getRows(`
            SELECT * FROM algeria_top50 
            WHERE username ILIKE $1 
            ORDER BY pp DESC 
            LIMIT 10
          `, [`%${username1}%`]),
          getRows(`
            SELECT * FROM algeria_top50 
            WHERE username ILIKE $1 
            ORDER BY pp DESC 
            LIMIT 10
          `, [`%${username2}%`])
        ]);
        
        const skillComparison = {};
        ['aim', 'speed', 'accuracy', 'reading', 'consistency'].forEach(skill => {
          const skill1 = skills1.find(s => s.skill_type === skill);
          const skill2 = skills2.find(s => s.skill_type === skill);
          
          skillComparison[skill] = {
            player1: skill1 ? parseFloat(skill1.avg_skill) : 0,
            player2: skill2 ? parseFloat(skill2.avg_skill) : 0,
            difference: (skill1 ? parseFloat(skill1.avg_skill) : 0) - (skill2 ? parseFloat(skill2.avg_skill) : 0)
          };
        });
        
        data = {
          player1: {
            ...player1,
            topScores: scores1
          },
          player2: {
            ...player2,
            topScores: scores2
          },
          skillComparison,
          statComparison: {
            totalPP: {
              player1: player1.total_pp || 0,
              player2: player2.total_pp || 0,
              difference: (player1.total_pp || 0) - (player2.total_pp || 0)
            },
            weightedPP: {
              player1: player1.weighted_pp || 0,
              player2: player2.weighted_pp || 0,
              difference: (player1.weighted_pp || 0) - (player2.weighted_pp || 0)
            },
            accuracy: {
              player1: player1.accuracy_avg || 0,
              player2: player2.accuracy_avg || 0,
              difference: (player1.accuracy_avg || 0) - (player2.accuracy_avg || 0)
            },
            firstPlaces: {
              player1: player1.first_places || 0,
              player2: player2.first_places || 0,
              difference: (player1.first_places || 0) - (player2.first_places || 0)
            },
            totalScores: {
              player1: player1.total_scores || 0,
              player2: player2.total_scores || 0,
              difference: (player1.total_scores || 0) - (player2.total_scores || 0)
            },
            countryRank: {
              player1: player1.country_rank || 999999,
              player2: player2.country_rank || 999999,
              difference: (player2.country_rank || 999999) - (player1.country_rank || 999999) // Lower is better
            }
          }
        };
        
        // Cache for 10 minutes
        await cacheService.set(cacheKey, data, 600);
      }
      
      res.json({ success: true, data });
    } catch (error) {
      console.error('Compare players error:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
);

// Compare player statistics on specific beatmap
router.get('/:username1/:username2/beatmap/:beatmapId',
  validateInput({
    username1: { required: true, minLength: 2 },
    username2: { required: true, minLength: 2 },
    beatmapId: { required: true, type: 'number' }
  }),
  async (req, res) => {
    try {
      const { username1, username2, beatmapId } = req.params;
      
      const [score1, score2, beatmapInfo] = await Promise.all([
        getRow(`
          SELECT * FROM algeria_top50 
          WHERE username ILIKE $1 AND beatmap_id = $2
        `, [`%${username1}%`, beatmapId]),
        getRow(`
          SELECT * FROM algeria_top50 
          WHERE username ILIKE $1 AND beatmap_id = $2
        `, [`%${username2}%`, beatmapId]),
        getRow(`
          SELECT * FROM beatmap_metadata 
          WHERE beatmap_id = $1
        `, [beatmapId])
      ]);
      
      if (!score1 && !score2) {
        return res.status(404).json({
          success: false,
          error: 'Neither player has a score on this beatmap'
        });
      }
      
      const comparison = {
        beatmap: beatmapInfo,
        player1: {
          username: username1,
          score: score1,
          hasScore: !!score1
        },
        player2: {
          username: username2,
          score: score2,
          hasScore: !!score2
        },
        winner: null
      };
      
      if (score1 && score2) {
        // Determine winner based on rank (lower is better)
        if (score1.rank < score2.rank) {
          comparison.winner = username1;
        } else if (score2.rank < score1.rank) {
          comparison.winner = username2;
        } else {
          comparison.winner = 'tie';
        }
        
        comparison.differences = {
          rank: score1.rank - score2.rank,
          score: score1.score - score2.score,
          accuracy: score1.accuracy - score2.accuracy,
          pp: (score1.pp || 0) - (score2.pp || 0),
          maxCombo: (score1.max_combo || 0) - (score2.max_combo || 0)
        };
      } else if (score1) {
        comparison.winner = username1;
      } else {
        comparison.winner = username2;
      }
      
      res.json({
        success: true,
        data: comparison
      });
    } catch (error) {
      console.error('Beatmap comparison error:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
);

// Compare multiple players (up to 5)
router.post('/multiple', async (req, res) => {
  try {
    const { usernames = [], metrics = ['weighted_pp', 'accuracy_avg', 'first_places'] } = req.body;
    
    if (usernames.length < 2 || usernames.length > 5) {
      return res.status(400).json({
        success: false,
        error: 'Please provide between 2 and 5 usernames'
      });
    }
    
    const players = [];
    
    for (const username of usernames) {
      const player = await getRow(`
        SELECT * FROM player_stats 
        WHERE username ILIKE $1
      `, [`%${username}%`]);
      
      if (player) {
        players.push(player);
      }
    }
    
    if (players.length < 2) {
      return res.status(404).json({
        success: false,
        error: 'At least 2 valid players required'
      });
    }
    
    // Create comparison matrix
    const comparison = {
      players,
      metrics: {},
      rankings: {}
    };
    
    // Calculate rankings for each metric
    metrics.forEach(metric => {
      const sortedPlayers = [...players].sort((a, b) => {
        const aVal = a[metric] || 0;
        const bVal = b[metric] || 0;
        return metric === 'avg_rank' ? aVal - bVal : bVal - aVal; // Lower avg_rank is better
      });
      
      comparison.rankings[metric] = sortedPlayers.map((player, index) => ({
        username: player.username,
        value: player[metric] || 0,
        rank: index + 1
      }));
      
      comparison.metrics[metric] = {
        best: sortedPlayers[0][metric] || 0,
        worst: sortedPlayers[sortedPlayers.length - 1][metric] || 0,
        average: players.reduce((sum, p) => sum + (p[metric] || 0), 0) / players.length
      };
    });
    
    res.json({
      success: true,
      data: comparison
    });
  } catch (error) {
    console.error('Multiple comparison error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Head-to-head matchup on common beatmaps
router.get('/:username1/:username2/head-to-head',
  validateInput({
    username1: { required: true, minLength: 2 },
    username2: { required: true, minLength: 2 }
  }),
  async (req, res) => {
    try {
      const { username1, username2 } = req.params;
      const { limit = 20 } = req.query;
      
      // Find beatmaps where both players have scores
      const commonBeatmaps = await getRows(`
        SELECT 
          s1.beatmap_id,
          s1.beatmap_title,
          s1.artist,
          s1.difficulty_name,
          s1.difficulty_rating,
          s1.username as player1_username,
          s1.rank as player1_rank,
          s1.score as player1_score,
          s1.accuracy as player1_accuracy,
          s1.pp as player1_pp,
          s1.mods as player1_mods,
          s2.username as player2_username,
          s2.rank as player2_rank,
          s2.score as player2_score,
          s2.accuracy as player2_accuracy,
          s2.pp as player2_pp,
          s2.mods as player2_mods,
          CASE 
            WHEN s1.rank < s2.rank THEN $1
            WHEN s2.rank < s1.rank THEN $2
            ELSE 'tie'
          END as winner
        FROM algeria_top50 s1
        JOIN algeria_top50 s2 ON s1.beatmap_id = s2.beatmap_id
        WHERE s1.username ILIKE $3 AND s2.username ILIKE $4
        ORDER BY GREATEST(s1.pp, s2.pp) DESC
        LIMIT $5
      `, [username1, username2, `%${username1}%`, `%${username2}%`, parseInt(limit)]);
      
      if (commonBeatmaps.length === 0) {
        return res.json({
          success: true,
          data: {
            commonBeatmaps: [],
            summary: {
              totalBeatmaps: 0,
              player1Wins: 0,
              player2Wins: 0,
              ties: 0
            }
          }
        });
      }
      
      // Calculate summary statistics
      const summary = commonBeatmaps.reduce((acc, beatmap) => {
        acc.totalBeatmaps++;
        if (beatmap.winner === username1) {
          acc.player1Wins++;
        } else if (beatmap.winner === username2) {
          acc.player2Wins++;
        } else {
          acc.ties++;
        }
        return acc;
      }, {
        totalBeatmaps: 0,
        player1Wins: 0,
        player2Wins: 0,
        ties: 0
      });
      
      res.json({
        success: true,
        data: {
          commonBeatmaps,
          summary,
          players: {
            player1: username1,
            player2: username2
          }
        }
      });
    } catch (error) {
      console.error('Head-to-head error:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
);

module.exports = router;
