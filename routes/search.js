const express = require('express');
const router = express.Router();
const { getRows } = require('../config/db');
const { cacheService } = require('../services/cache');
const { validateInput } = require('../config/security');

// Main search endpoint
router.get('/', 
  validateInput({
    q: { required: true, minLength: 2, maxLength: 50 }
  }),
  async (req, res) => {
    try {
      const { q, type = 'all', limit = 20 } = req.query;
      const searchTerm = q.trim();
      
      // Try cache first
      let data = await cacheService.getSearchCache(searchTerm, type);
      
      if (!data) {
        const results = {};
        
        if (type === 'all' || type === 'players') {
          results.players = await getRows(`
            SELECT 
              username, 
              user_id, 
              weighted_pp, 
              first_places, 
              avatar_url, 
              country_rank,
              accuracy_avg,
              total_scores
            FROM player_stats
            WHERE username ILIKE $1 AND is_active = true
            ORDER BY weighted_pp DESC
            LIMIT $2
          `, [`%${searchTerm}%`, parseInt(limit)]);
        }
        
        if (type === 'all' || type === 'beatmaps') {
          results.beatmaps = await getRows(`
            SELECT DISTINCT 
              bm.beatmap_id, 
              bm.artist, 
              bm.title, 
              bm.version,
              bm.difficulty_rating,
              bm.creator,
              COUNT(ats.username) as algerian_players,
              AVG(ats.accuracy) as avg_accuracy,
              MAX(ats.pp) as best_pp
            FROM beatmap_metadata bm
            LEFT JOIN algeria_top50 ats ON bm.beatmap_id = ats.beatmap_id
            WHERE bm.artist ILIKE $1 OR bm.title ILIKE $1 OR bm.version ILIKE $1 OR bm.creator ILIKE $1
            GROUP BY bm.beatmap_id, bm.artist, bm.title, bm.version, bm.difficulty_rating, bm.creator
            ORDER BY algerian_players DESC, bm.difficulty_rating DESC
            LIMIT $2
          `, [`%${searchTerm}%`, parseInt(limit)]);
        }
        
        if (type === 'all' || type === 'scores') {
          results.scores = await getRows(`
            SELECT 
              beatmap_id, 
              beatmap_title, 
              artist, 
              difficulty_name,
              username, 
              rank, 
              score, 
              accuracy, 
              mods, 
              pp,
              last_updated
            FROM algeria_top50
            WHERE beatmap_title ILIKE $1 OR artist ILIKE $1 OR username ILIKE $1
            ORDER BY pp DESC
            LIMIT $2
          `, [`%${searchTerm}%`, parseInt(limit)]);
        }
        
        data = results;
        
        // Cache for 10 minutes
        await cacheService.cacheSearch(searchTerm, type, data, 600);
      }
      
      res.json({ 
        success: true, 
        query: searchTerm, 
        type,
        data 
      });
    } catch (error) {
      console.error('Search error:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
);

// Search players specifically
router.get('/players', 
  validateInput({
    q: { required: true, minLength: 2, maxLength: 50 }
  }),
  async (req, res) => {
    try {
      const { q, limit = 20, sortBy = 'pp' } = req.query;
      const searchTerm = q.trim();
      
      const sortColumns = {
        pp: 'weighted_pp DESC',
        accuracy: 'accuracy_avg DESC',
        scores: 'total_scores DESC',
        firsts: 'first_places DESC',
        name: 'username ASC'
      };
      
      const orderBy = sortColumns[sortBy] || sortColumns.pp;
      
      const data = await getRows(`
        SELECT 
          username, 
          user_id, 
          weighted_pp, 
          accuracy_avg,
          first_places, 
          total_scores,
          avatar_url, 
          country_rank,
          last_seen
        FROM player_stats
        WHERE username ILIKE $1 AND is_active = true
        ORDER BY ${orderBy}
        LIMIT $2
      `, [`%${searchTerm}%`, parseInt(limit)]);
      
      res.json({
        success: true,
        query: searchTerm,
        data,
        meta: {
          sortBy,
          limit: parseInt(limit),
          resultsCount: data.length
        }
      });
    } catch (error) {
      console.error('Player search error:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
);

// Search beatmaps specifically
router.get('/beatmaps', 
  validateInput({
    q: { required: true, minLength: 2, maxLength: 50 }
  }),
  async (req, res) => {
    try {
      const { q, limit = 20, sortBy = 'popularity' } = req.query;
      const searchTerm = q.trim();
      
      let orderBy;
      switch (sortBy) {
        case 'difficulty':
          orderBy = 'bm.difficulty_rating DESC';
          break;
        case 'alphabetical':
          orderBy = 'bm.artist ASC, bm.title ASC';
          break;
        case 'pp':
          orderBy = 'MAX(ats.pp) DESC';
          break;
        default: // popularity
          orderBy = 'COUNT(ats.username) DESC';
      }
      
      const data = await getRows(`
        SELECT DISTINCT 
          bm.beatmap_id, 
          bm.artist, 
          bm.title, 
          bm.version,
          bm.difficulty_rating,
          bm.creator,
          bm.length,
          bm.bpm,
          COUNT(ats.username) as algerian_players,
          AVG(ats.accuracy) as avg_accuracy,
          MAX(ats.pp) as best_pp,
          MAX(ats.score) as best_score
        FROM beatmap_metadata bm
        LEFT JOIN algeria_top50 ats ON bm.beatmap_id = ats.beatmap_id
        WHERE 
          bm.artist ILIKE $1 OR 
          bm.title ILIKE $1 OR 
          bm.version ILIKE $1 OR 
          bm.creator ILIKE $1
        GROUP BY bm.beatmap_id, bm.artist, bm.title, bm.version, bm.difficulty_rating, bm.creator, bm.length, bm.bpm
        ORDER BY ${orderBy}
        LIMIT $2
      `, [`%${searchTerm}%`, parseInt(limit)]);
      
      res.json({
        success: true,
        query: searchTerm,
        data,
        meta: {
          sortBy,
          limit: parseInt(limit),
          resultsCount: data.length
        }
      });
    } catch (error) {
      console.error('Beatmap search error:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
);

// Advanced search with filters
router.post('/advanced', async (req, res) => {
  try {
    const {
      query: searchQuery = '',
      filters = {},
      limit = 20,
      offset = 0
    } = req.body;

    const {
      type = 'all',
      minPP = 0,
      maxPP = 10000,
      minAccuracy = 0,
      maxAccuracy = 1,
      minDifficulty = 0,
      maxDifficulty = 10,
      mods = [],
      dateRange = {}
    } = filters;

    let results = {};

    if (type === 'all' || type === 'players') {
      let playerQuery = `
        SELECT 
          username, user_id, weighted_pp, accuracy_avg, first_places, 
          total_scores, avatar_url, country_rank
        FROM player_stats
        WHERE is_active = true
      `;
      let playerParams = [];
      let paramCount = 0;

      if (searchQuery) {
        playerQuery += ` AND username ILIKE ${++paramCount}`;
        playerParams.push(`%${searchQuery}%`);
      }

      if (minPP > 0) {
        playerQuery += ` AND weighted_pp >= ${++paramCount}`;
        playerParams.push(minPP);
      }

      if (maxPP < 10000) {
        playerQuery += ` AND weighted_pp <= ${++paramCount}`;
        playerParams.push(maxPP);
      }

      if (minAccuracy > 0) {
        playerQuery += ` AND accuracy_avg >= ${++paramCount}`;
        playerParams.push(minAccuracy);
      }

      if (maxAccuracy < 1) {
        playerQuery += ` AND accuracy_avg <= ${++paramCount}`;
        playerParams.push(maxAccuracy);
      }

      playerQuery += ` ORDER BY weighted_pp DESC LIMIT ${++paramCount} OFFSET ${++paramCount}`;
      playerParams.push(parseInt(limit), parseInt(offset));

      results.players = await getRows(playerQuery, playerParams);
    }

    if (type === 'all' || type === 'scores') {
      let scoreQuery = `
        SELECT 
          beatmap_id, beatmap_title, artist, difficulty_name, username,
          rank, score, accuracy, mods, pp, difficulty_rating, last_updated
        FROM algeria_top50
        WHERE 1=1
      `;
      let scoreParams = [];
      let paramCount = 0;

      if (searchQuery) {
        scoreQuery += ` AND (beatmap_title ILIKE ${++paramCount} OR artist ILIKE ${paramCount} OR username ILIKE ${paramCount})`;
        scoreParams.push(`%${searchQuery}%`);
      }

      if (minPP > 0) {
        scoreQuery += ` AND pp >= ${++paramCount}`;
        scoreParams.push(minPP);
      }

      if (maxPP < 10000) {
        scoreQuery += ` AND pp <= ${++paramCount}`;
        scoreParams.push(maxPP);
      }

      if (minAccuracy > 0) {
        scoreQuery += ` AND accuracy >= ${++paramCount}`;
        scoreParams.push(minAccuracy);
      }

      if (maxAccuracy < 1) {
        scoreQuery += ` AND accuracy <= ${++paramCount}`;
        scoreParams.push(maxAccuracy);
      }

      if (minDifficulty > 0) {
        scoreQuery += ` AND difficulty_rating >= ${++paramCount}`;
        scoreParams.push(minDifficulty);
      }

      if (maxDifficulty < 10) {
        scoreQuery += ` AND difficulty_rating <= ${++paramCount}`;
        scoreParams.push(maxDifficulty);
      }

      if (mods.length > 0) {
        scoreQuery += ` AND mods = ANY(${++paramCount})`;
        scoreParams.push(mods);
      }

      if (dateRange.start) {
        scoreQuery += ` AND last_updated >= ${++paramCount}`;
        scoreParams.push(new Date(dateRange.start).getTime());
      }

      if (dateRange.end) {
        scoreQuery += ` AND last_updated <= ${++paramCount}`;
        scoreParams.push(new Date(dateRange.end).getTime());
      }

      scoreQuery += ` ORDER BY pp DESC LIMIT ${++paramCount} OFFSET ${++paramCount}`;
      scoreParams.push(parseInt(limit), parseInt(offset));

      results.scores = await getRows(scoreQuery, scoreParams);
    }

    res.json({
      success: true,
      query: searchQuery,
      filters,
      data: results,
      meta: {
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });
  } catch (error) {
    console.error('Advanced search error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Search suggestions/autocomplete
router.get('/suggestions', 
  validateInput({
    q: { required: true, minLength: 1, maxLength: 50 }
  }),
  async (req, res) => {
    try {
      const { q, type = 'all', limit = 10 } = req.query;
      const searchTerm = q.trim();
      
      const suggestions = {};
      
      if (type === 'all' || type === 'players') {
        suggestions.players = await getRows(`
          SELECT username, avatar_url, weighted_pp
          FROM player_stats
          WHERE username ILIKE $1 AND is_active = true
          ORDER BY weighted_pp DESC
          LIMIT $2
        `, [`${searchTerm}%`, parseInt(limit)]);
      }
      
      if (type === 'all' || type === 'beatmaps') {
        suggestions.beatmaps = await getRows(`
          SELECT DISTINCT 
            CONCAT(artist, ' - ', title) as full_title,
            artist,
            title,
            COUNT(ats.username) as popularity
          FROM beatmap_metadata bm
          LEFT JOIN algeria_top50 ats ON bm.beatmap_id = ats.beatmap_id
          WHERE artist ILIKE $1 OR title ILIKE $1
          GROUP BY artist, title
          ORDER BY popularity DESC
          LIMIT $2
        `, [`${searchTerm}%`, parseInt(limit)]);
      }
      
      if (type === 'all' || type === 'artists') {
        suggestions.artists = await getRows(`
          SELECT DISTINCT 
            artist,
            COUNT(DISTINCT bm.beatmap_id) as beatmap_count,
            COUNT(ats.username) as score_count
          FROM beatmap_metadata bm
          LEFT JOIN algeria_top50 ats ON bm.beatmap_id = ats.beatmap_id
          WHERE artist ILIKE $1
          GROUP BY artist
          ORDER BY score_count DESC, beatmap_count DESC
          LIMIT $2
        `, [`${searchTerm}%`, parseInt(limit)]);
      }
      
      res.json({
        success: true,
        query: searchTerm,
        suggestions
      });
    } catch (error) {
      console.error('Search suggestions error:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
);

// Search history (if implemented)
router.get('/popular', async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    
    // Get most searched/popular content
    const popularPlayers = await getRows(`
      SELECT username, weighted_pp, first_places, avatar_url
      FROM player_stats
      WHERE is_active = true
      ORDER BY weighted_pp DESC
      LIMIT $1
    `, [parseInt(limit) / 2]);
    
    const popularBeatmaps = await getRows(`
      SELECT DISTINCT 
        bm.beatmap_id,
        bm.artist,
        bm.title,
        bm.version,
        bm.difficulty_rating,
        COUNT(ats.username) as algerian_players
      FROM beatmap_metadata bm
      LEFT JOIN algeria_top50 ats ON bm.beatmap_id = ats.beatmap_id
      GROUP BY bm.beatmap_id, bm.artist, bm.title, bm.version, bm.difficulty_rating
      ORDER BY algerian_players DESC
      LIMIT $1
    `, [parseInt(limit) / 2]);
    
    res.json({
      success: true,
      data: {
        players: popularPlayers,
        beatmaps: popularBeatmaps
      }
    });
  } catch (error) {
    console.error('Popular search error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Search statistics
router.get('/stats', async (req, res) => {
  try {
    const stats = await getRows(`
      SELECT 
        'players' as category,
        COUNT(*) as total_count
      FROM player_stats 
      WHERE is_active = true
      
      UNION ALL
      
      SELECT 
        'beatmaps' as category,
        COUNT(DISTINCT beatmap_id) as total_count
      FROM algeria_top50
      
      UNION ALL
      
      SELECT 
        'scores' as category,
        COUNT(*) as total_count
      FROM algeria_top50
      
      UNION ALL
      
      SELECT 
        'artists' as category,
        COUNT(DISTINCT artist) as total_count
      FROM beatmap_metadata
    `);
    
    const searchStats = stats.reduce((acc, stat) => {
      acc[stat.category] = parseInt(stat.total_count);
      return acc;
    }, {});
    
    res.json({
      success: true,
      data: searchStats
    });
  } catch (error) {
    console.error('Search stats error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
