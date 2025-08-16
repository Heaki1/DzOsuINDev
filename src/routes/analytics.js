const express = require('express');
const router = express.Router();
const { getRows, getRow } = require('../config/db');
const { cacheService } = require('../services/cache');
const { statsService } = require('../services/stats');
const { getSkillStatistics } = require('../services/skillCalculator');

// Overview analytics
router.get('/overview', async (req, res) => {
  try {
    const cacheKey = 'analytics_overview';
    let data = await cacheService.getAnalyticsCache('overview');
    
    if (!data) {
      const [
        totalStats, recentActivity, topPerformers, 
        skillDistribution, modUsage, difficultyDistribution
      ] = await Promise.all([
        getRow(`
          SELECT 
            COUNT(DISTINCT username) as total_players,
            COUNT(*) as total_scores,
            COUNT(DISTINCT beatmap_id) as total_beatmaps,
            AVG(accuracy) as avg_accuracy,
            MAX(score) as highest_score,
            SUM(pp) as total_pp
          FROM algeria_top50
        `),
        getRow(`
          SELECT COUNT(*) as active_24h
          FROM algeria_top50
          WHERE last_updated > $1
        `, [Date.now() - (24 * 60 * 60 * 1000)]),
        getRows(`
          SELECT username, weighted_pp, first_places, avatar_url
          FROM player_stats
          WHERE is_active = true
          ORDER BY weighted_pp DESC
          LIMIT 5
        `),
        getSkillStatistics(),
        getRows(`
          SELECT 
            mods, 
            COUNT(*) as usage_count,
            AVG(accuracy) as avg_accuracy,
            AVG(pp) as avg_pp
          FROM algeria_top50
          WHERE mods != 'None'
          GROUP BY mods
          ORDER BY usage_count DESC
          LIMIT 10
        `),
        getRows(`
          SELECT 
            FLOOR(difficulty_rating) as difficulty_range,
            COUNT(*) as score_count,
            AVG(accuracy) as avg_accuracy
          FROM algeria_top50
          WHERE difficulty_rating > 0
          GROUP BY FLOOR(difficulty_rating)
          ORDER BY difficulty_range ASC
        `)
      ]);
      
      data = {
        totalStats: {
          ...totalStats,
          active24h: parseInt(recentActivity.active_24h)
        },
        topPerformers,
        skillDistribution,
        modUsage,
        difficultyDistribution
      };

      await cacheService.cacheAnalytics('overview', data, 900); // Cache for 15 minutes
    }
    
    res.json({ success: true, data });
  } catch (error) {
    console.error('Analytics overview error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Player growth analytics
router.get('/growth', async (req, res) => {
  try {
    const { period = 'month' } = req.query;
    
    const cacheKey = `analytics_growth_${period}`;
    let data = await cacheService.getAnalyticsCache(`growth_${period}`);
    
    if (!data) {
      data = await statsService.getPlayerGrowthStats();
      await cacheService.cacheAnalytics(`growth_${period}`, data, 1800); // Cache for 30 minutes
    }
    
    res.json({ success: true, data });
  } catch (error) {
    console.error('Growth analytics error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Performance distribution
router.get('/performance-distribution', async (req, res) => {
  try {
    const cacheKey = 'analytics_performance_distribution';
    let data = await cacheService.getAnalyticsCache('performance_distribution');
    
    if (!data) {
      data = await statsService.getPerformanceDistribution();
      await cacheService.cacheAnalytics('performance_distribution', data, 3600); // Cache for 1 hour
    }
    
    res.json({ success: true, data });
  } catch (error) {
    console.error('Performance distribution error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Activity trends
router.get('/activity', async (req, res) => {
  try {
    const { days = 30 } = req.query;
    
    const data = await statsService.getPlayerActivityTrends(parseInt(days));
    
    res.json({
      success: true,
      data,
      meta: {
        days: parseInt(days)
      }
    });
  } catch (error) {
    console.error('Activity analytics error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Skill analytics
router.get('/skills', async (req, res) => {
  try {
    const { skillType } = req.query;
    
    const cacheKey = `analytics_skills_${skillType || 'all'}`;
    let data = await cacheService.getAnalyticsCache(`skills_${skillType || 'all'}`);
    
    if (!data) {
      if (skillType) {
        // Get specific skill distribution
        data = await getRows(`
          WITH recent_skills AS (
            SELECT DISTINCT ON (username) username, skill_value
            FROM skill_tracking 
            WHERE skill_type = $1
            ORDER BY username, calculated_at DESC
          )
          SELECT 
            CASE 
              WHEN skill_value >= 8.0 THEN '8.0+'
              WHEN skill_value >= 6.0 THEN '6.0-7.99'
              WHEN skill_value >= 4.0 THEN '4.0-5.99'
              WHEN skill_value >= 2.0 THEN '2.0-3.99'
              ELSE '0.0-1.99'
            END
          ORDER BY 
            CASE skill_range
              WHEN '0.0-1.99' THEN 1
              WHEN '2.0-3.99' THEN 2
              WHEN '4.0-5.99' THEN 3
              WHEN '6.0-7.99' THEN 4
              WHEN '8.0+' THEN 5
            END
        `, [skillType]);
      } else {
        // Get overall skill statistics
        data = await getSkillStatistics();
      }
      
      await cacheService.cacheAnalytics(`skills_${skillType || 'all'}`, data, 1800);
    }
    
    res.json({ 
      success: true, 
      data,
      meta: { skillType }
    });
  } catch (error) {
    console.error('Skill analytics error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Beatmap popularity analytics
router.get('/beatmaps', async (req, res) => {
  try {
    const { sortBy = 'popularity', limit = 50 } = req.query;
    
    const cacheKey = `analytics_beatmaps_${sortBy}_${limit}`;
    let data = await cacheService.getAnalyticsCache(`beatmaps_${sortBy}_${limit}`);
    
    if (!data) {
      data = await statsService.getBeatmapPopularityStats(parseInt(limit));
      await cacheService.cacheAnalytics(`beatmaps_${sortBy}_${limit}`, data, 1800);
    }
    
    res.json({
      success: true,
      data,
      meta: {
        sortBy,
        limit: parseInt(limit)
      }
    });
  } catch (error) {
    console.error('Beatmap analytics error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Mod usage analytics
router.get('/mods', async (req, res) => {
  try {
    const cacheKey = 'analytics_mods';
    let data = await cacheService.getAnalyticsCache('mods');
    
    if (!data) {
      const modStats = await getRows(`
        SELECT 
          mods,
          COUNT(*) as usage_count,
          AVG(accuracy) as avg_accuracy,
          AVG(pp) as avg_pp,
          MAX(pp) as max_pp,
          COUNT(DISTINCT username) as unique_users,
          COUNT(DISTINCT beatmap_id) as unique_beatmaps
        FROM algeria_top50
        WHERE mods IS NOT NULL AND mods != 'None'
        GROUP BY mods
        ORDER BY usage_count DESC
      `);
      
      const totalScores = await getRow(`
        SELECT COUNT(*) as total FROM algeria_top50
      `);
      
      data = {
        modStats: modStats.map(mod => ({
          ...mod,
          usage_percentage: (mod.usage_count / totalScores.total) * 100
        })),
        totalScores: parseInt(totalScores.total)
      };
      
      await cacheService.cacheAnalytics('mods', data, 3600);
    }
    
    res.json({ success: true, data });
  } catch (error) {
    console.error('Mod analytics error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Time-based analytics
router.get('/timeline', async (req, res) => {
  try {
    const { 
      period = 'week', 
      metric = 'scores',
      groupBy = 'day' 
    } = req.query;
    
    let dateFormat, interval;
    switch (groupBy) {
      case 'hour':
        dateFormat = 'YYYY-MM-DD HH24:00:00';
        interval = '1 hour';
        break;
      case 'day':
        dateFormat = 'YYYY-MM-DD';
        interval = '1 day';
        break;
      case 'week':
        dateFormat = 'IYYY-IW';
        interval = '1 week';
        break;
      case 'month':
        dateFormat = 'YYYY-MM';
        interval = '1 month';
        break;
      default:
        dateFormat = 'YYYY-MM-DD';
        interval = '1 day';
    }
    
    const periodMap = {
      'day': '1 day',
      'week': '7 days',
      'month': '30 days',
      'quarter': '90 days',
      'year': '365 days'
    };
    
    const data = await getRows(`
      SELECT 
        TO_CHAR(to_timestamp(last_updated / 1000), $1) as time_period,
        COUNT(*) as score_count,
        COUNT(DISTINCT username) as unique_players,
        COUNT(DISTINCT beatmap_id) as unique_beatmaps,
        AVG(accuracy) as avg_accuracy,
        AVG(pp) as avg_pp
      FROM algeria_top50
      WHERE last_updated > EXTRACT(EPOCH FROM (NOW() - INTERVAL $2)) * 1000
      GROUP BY time_period
      ORDER BY time_period ASC
    `, [dateFormat, periodMap[period] || '7 days']);
    
    res.json({
      success: true,
      data,
      meta: {
        period,
        metric,
        groupBy
      }
    });
  } catch (error) {
    console.error('Timeline analytics error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Comparative analytics (country vs global trends)
router.get('/comparative', async (req, res) => {
  try {
    const cacheKey = 'analytics_comparative';
    let data = await cacheService.getAnalyticsCache('comparative');
    
    if (!data) {
      const [algeriaStats, difficultyComparison, accuracyComparison] = await Promise.all([
        getRow(`
          SELECT 
            COUNT(DISTINCT username) as total_players,
            AVG(accuracy) as avg_accuracy,
            AVG(difficulty_rating) as avg_difficulty,
            COUNT(*) as total_scores
          FROM algeria_top50
        `),
        getRows(`
          SELECT 
            CASE 
              WHEN difficulty_rating < 4.0 THEN 'Easy (< 4★)'
              WHEN difficulty_rating < 6.0 THEN 'Medium (4-6★)'
              WHEN difficulty_rating < 8.0 THEN 'Hard (6-8★)'
              ELSE 'Expert (8★+)'
            END as difficulty_category,
            COUNT(*) as score_count,
            AVG(accuracy) as avg_accuracy,
            COUNT(DISTINCT username) as player_count
          FROM algeria_top50
          WHERE difficulty_rating > 0
          GROUP BY 
            CASE 
              WHEN difficulty_rating < 4.0 THEN 'Easy (< 4★)'
              WHEN difficulty_rating < 6.0 THEN 'Medium (4-6★)'
              WHEN difficulty_rating < 8.0 THEN 'Hard (6-8★)'
              ELSE 'Expert (8★+)'
            END
          ORDER BY 
            CASE difficulty_category
              WHEN 'Easy (< 4★)' THEN 1
              WHEN 'Medium (4-6★)' THEN 2
              WHEN 'Hard (6-8★)' THEN 3
              WHEN 'Expert (8★+)' THEN 4
            END
        `),
        getRows(`
          SELECT 
            CASE 
              WHEN accuracy >= 0.98 THEN 'SS (98%+)'
              WHEN accuracy >= 0.95 THEN 'S (95-98%)'
              WHEN accuracy >= 0.90 THEN 'A (90-95%)'
              WHEN accuracy >= 0.80 THEN 'B (80-90%)'
              ELSE 'C (< 80%)'
            END as grade_category,
            COUNT(*) as score_count,
            COUNT(DISTINCT username) as player_count
          FROM algeria_top50
          WHERE accuracy > 0
          GROUP BY 
            CASE 
              WHEN accuracy >= 0.98 THEN 'SS (98%+)'
              WHEN accuracy >= 0.95 THEN 'S (95-98%)'
              WHEN accuracy >= 0.90 THEN 'A (90-95%)'
              WHEN accuracy >= 0.80 THEN 'B (80-90%)'
              ELSE 'C (< 80%)'
            END
          ORDER BY 
            CASE grade_category
              WHEN 'SS (98%+)' THEN 1
              WHEN 'S (95-98%)' THEN 2
              WHEN 'A (90-95%)' THEN 3
              WHEN 'B (80-90%)' THEN 4
              WHEN 'C (< 80%)' THEN 5
            END
        `)
      ]);
      
      data = {
        overallStats: algeriaStats,
        difficultyBreakdown: difficultyComparison,
        accuracyBreakdown: accuracyComparison
      };
      
      await cacheService.cacheAnalytics('comparative', data, 3600);
    }
    
    res.json({ success: true, data });
  } catch (error) {
    console.error('Comparative analytics error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Export analytics data
router.get('/export', async (req, res) => {
  try {
    const { 
      format = 'json',
      type = 'overview',
      startDate,
      endDate 
    } = req.query;
    
    let data;
    
    switch (type) {
      case 'daily_stats':
        if (startDate && endDate) {
          data = await statsService.getDailyStatsRange(startDate, endDate);
          
          if (format === 'csv') {
            const csvContent = await statsService.exportStatsToCSV(startDate, endDate);
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename="algeria_osu_stats.csv"');
            return res.send(csvContent);
          }
        } else {
          data = await statsService.getWeeklyStats();
        }
        break;
        
      case 'players':
        data = await getRows(`
          SELECT 
            username, weighted_pp, accuracy_avg, first_places, 
            total_scores, country_rank, last_seen
          FROM player_stats
          WHERE is_active = true
          ORDER BY weighted_pp DESC
        `);
        break;
        
      case 'beatmaps':
        data = await statsService.getBeatmapPopularityStats(1000);
        break;
        
      default:
        // Get overview data
        data = await cacheService.getAnalyticsCache('overview');
        if (!data) {
          data = await statsService.getOverallStats();
        }
    }
    
    res.json({
      success: true,
      data,
      meta: {
        exportDate: new Date().toISOString(),
        format,
        type,
        startDate,
        endDate
      }
    });
  } catch (error) {
    console.error('Export analytics error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
