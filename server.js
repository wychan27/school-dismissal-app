require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
// Use environment variable for PORT, with 3000 as fallback for local development
const PORT = process.env.PORT || 3000;

// Connect to the PostgreSQL database (Supabase)
// Use environment variable for database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Test the connection
pool.connect((err, client, release) => {
    if (err) {
        console.error('Error connecting to database:', err);
    } else {
        console.log('Connected to PostgreSQL database!');
        release();
    }
});

// Middleware to parse form data
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Simple session storage (in production, use Redis or database)
const sessions = new Map();

// Generate a simple session ID
function generateSessionId() {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Middleware to check if user is logged in as admin
function requireAdminAuth(req, res, next) {
    const sessionId = req.headers.cookie?.split('admin_session=')[1]?.split(';')[0];
    
    if (!sessionId || !sessions.has(sessionId)) {
        return res.redirect('/admin-login');
    }
    
    const session = sessions.get(sessionId);
    if (session.role !== 'admin') {
        return res.redirect('/admin-login');
    }
    
    next();
}

// Serve static files (HTML, CSS) from the public folder
app.use(express.static(path.join(__dirname, 'public')));

// --- New Route for Parent Portal Landing Page ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'parent-portal.html'));
});

// --- Route for Admin Login Page ---
app.get('/admin-login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

// --- API route for admin login ---
// In your server.js, replace the admin login route with this:

app.post('/api/admin-login', (req, res) => {
    const { username, password } = req.body;
    
    // Get credentials from environment variables
    const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
    
    // Check if environment variables are set
    if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
        console.error('Admin credentials not configured in environment variables');
        return res.json({ success: false, message: 'Server configuration error' });
    }
    
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        // Create a session
        const sessionId = generateSessionId();
        sessions.set(sessionId, {
            username: username,
            role: 'admin',
            loginTime: new Date()
        });
        
        // Set session cookie
        res.cookie('admin_session', sessionId, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 24 * 60 * 60 * 1000 // 24 hours
        });
        
        res.json({ success: true, message: 'Login successful' });
    } else {
        res.json({ success: false, message: 'Invalid username or password' });
    }
});

// --- API route for admin logout ---
app.post('/api/admin-logout', (req, res) => {
    const sessionId = req.headers.cookie?.split('admin_session=')[1]?.split(';')[0];
    
    if (sessionId && sessions.has(sessionId)) {
        sessions.delete(sessionId);
    }
    
    res.clearCookie('admin_session');
    res.json({ success: true, message: 'Logged out successfully' });
});

// --- Protected Route for Admin Dashboard ---
app.get('/admin-dashboard', requireAdminAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin-dashboard.html'));
});

// --- OLD /admin route now redirects to login ---
app.get('/admin', (req, res) => {
    res.redirect('/admin-login');
});

// --- Existing Route for Parent Registration Form ---
app.get('/register-child', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'parent-form.html'));
});

// Route to handle form submissions
app.post('/register', async (req, res) => {
    console.log('Form submitted:', req.body);
    
    const client = await pool.connect();
    
    try {
        // Start a transaction
        await client.query('BEGIN');
        
        // Extract child information from the form
        const { firstName, lastName, parentEmail, parentPhone } = req.body;
        
        // Insert the student into the database
        const studentResult = await client.query(
            'INSERT INTO students (first_name, last_name, parent_email, parent_phone) VALUES ($1, $2, $3, $4) RETURNING id',
            [firstName, lastName, parentEmail, parentPhone]
        );
        
        const studentId = studentResult.rows[0].id;
        console.log('Student inserted with ID:', studentId);
        
        // Days of the week
        const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
        
        // Insert pickup schedules for each day
        for (const day of days) {
            const timeField = day + 'Time';
            const locationField = day + 'Location';
            
            const pickupTime = req.body[timeField];
            const pickupLocation = req.body[locationField];
            
            // Only save if both time and location are provided
            if (pickupTime && pickupLocation) {
                await client.query(
                    'INSERT INTO pickup_schedules (student_id, day_of_week, pickup_time, pickup_location) VALUES ($1, $2, $3, $4)',
                    [studentId, day.charAt(0).toUpperCase() + day.slice(1), pickupTime, pickupLocation]
                );
            }
        }
        
        // Commit the transaction
        await client.query('COMMIT');
        //add new code - redirect to successful page
        //res.sendFile(path.join(__dirname, 'public', 'registration-success.html'));
        // redirect code?
        return res.redirect('registration-success.html');
        res.send('Registration successful! Student ID: ' + studentId + ' with pickup schedules saved.');
        
        
    } catch (err) {
        // Rollback the transaction on error
        await client.query('ROLLBACK');
        console.error('Error during registration:', err);
        res.status(500).send('Error saving student information');
    } finally {
        client.release();
    }
});

// --- PROTECTED API ROUTES (require admin login) ---

// API route to get schedules for a specific day
app.get('/api/schedules/:day', requireAdminAuth, async (req, res) => {
    const day = req.params.day;
    const dayCapitalized = day.charAt(0).toUpperCase() + day.slice(1);
    
    const query = `
        SELECT 
            s.first_name,
            s.last_name,
            s.parent_email,
            s.parent_phone,
            ps.pickup_time,
            ps.pickup_location
        FROM students s
        JOIN pickup_schedules ps ON s.id = ps.student_id
        WHERE ps.day_of_week = $1
        ORDER BY ps.pickup_time ASC, s.last_name ASC, s.first_name ASC
    `;
    
    try {
        const result = await pool.query(query, [dayCapitalized]);
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching schedules for ' + day + ':', err);
        res.status(500).json({ error: 'Failed to fetch schedules' });
    }
});

// API route to get summary statistics
app.get('/api/summary', requireAdminAuth, async (req, res) => {
    const queries = {
        totalStudents: 'SELECT COUNT(*) as count FROM students',
        totalSchedules: 'SELECT COUNT(*) as count FROM pickup_schedules',
        mondayCount: 'SELECT COUNT(*) as count FROM pickup_schedules WHERE day_of_week = $1',
        tuesdayCount: 'SELECT COUNT(*) as count FROM pickup_schedules WHERE day_of_week = $1',
        wednesdayCount: 'SELECT COUNT(*) as count FROM pickup_schedules WHERE day_of_week = $1',
        thursdayCount: 'SELECT COUNT(*) as count FROM pickup_schedules WHERE day_of_week = $1',
        fridayCount: 'SELECT COUNT(*) as count FROM pickup_schedules WHERE day_of_week = $1'
    };
    
    try {
        const results = {};
        
        // Get total students and schedules
        const totalStudentsResult = await pool.query(queries.totalStudents);
        results.totalStudents = parseInt(totalStudentsResult.rows[0].count);
        
        const totalSchedulesResult = await pool.query(queries.totalSchedules);
        results.totalSchedules = parseInt(totalSchedulesResult.rows[0].count);
        
        // Get counts for each day
        const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
        const dayKeys = ['mondayCount', 'tuesdayCount', 'wednesdayCount', 'thursdayCount', 'fridayCount'];
        
        for (let i = 0; i < days.length; i++) {
            const dayResult = await pool.query(queries[dayKeys[i]], [days[i]]);
            results[dayKeys[i]] = parseInt(dayResult.rows[0].count);
        }
        
        res.json(results);
    } catch (err) {
        console.error('Error fetching summary:', err);
        res.status(500).json({ error: 'Failed to fetch summary' });
    }
});

// API route to get all students
app.get('/api/students', requireAdminAuth, async (req, res) => {
    const query = `
        SELECT 
            s.id,
            s.first_name,
            s.last_name,
            s.parent_email,
            s.parent_phone,
            COUNT(ps.id) as schedule_count
        FROM students s
        LEFT JOIN pickup_schedules ps ON s.id = ps.student_id
        GROUP BY s.id, s.first_name, s.last_name, s.parent_email, s.parent_phone
        ORDER BY s.last_name ASC, s.first_name ASC
    `;
    
    try {
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching students:', err);
        res.status(500).json({ error: 'Failed to fetch students' });
    }
});

// API route to get all schedules for a specific student
app.get('/api/student/:id/schedules', requireAdminAuth, async (req, res) => {
    const studentId = req.params.id;
    
    const query = `
        SELECT 
            ps.day_of_week,
            ps.pickup_time,
            ps.pickup_location,
            s.first_name,
            s.last_name
        FROM pickup_schedules ps
        JOIN students s ON ps.student_id = s.id
        WHERE ps.student_id = $1
        ORDER BY 
            CASE ps.day_of_week
                WHEN 'Monday' THEN 1
                WHEN 'Tuesday' THEN 2
                WHEN 'Wednesday' THEN 3
                WHEN 'Thursday' THEN 4
                WHEN 'Friday' THEN 5
            END,
            ps.pickup_time ASC
    `;
    
    try {
        const result = await pool.query(query, [studentId]);
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching student schedules:', err);
        res.status(500).json({ error: 'Failed to fetch student schedules' });
    }
});

// Route for Edit Schedule Page
app.get('/edit-schedule', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'parent_edit_form.html'));
});

// API route to search for a student by name and email
app.post('/api/search-student', async (req, res) => {
    const { firstName, lastName, parentEmail } = req.body;
    
    if (!firstName || !lastName || !parentEmail) {
        return res.json({ success: false, message: 'Missing required fields' });
    }
    
    const query = `
        SELECT * FROM students 
        WHERE first_name = $1 AND last_name = $2 AND parent_email = $3
    `;
    
    try {
        const result = await pool.query(query, [firstName, lastName, parentEmail]);
        
        if (result.rows.length === 0) {
            return res.json({ 
                success: false, 
                message: 'Student not found. Please check the name and email address.' 
            });
        }
        
        res.json({ success: true, student: result.rows[0] });
    } catch (err) {
        console.error('Error searching for student:', err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

// Added new Edit schedule functionality
// API route for parents to get their child's schedule (no admin auth required)
app.post('/api/parent/student-schedule', async (req, res) => {
    const { firstName, lastName, parentEmail } = req.body;
    
    if (!firstName || !lastName || !parentEmail) {
        return res.json({ success: false, message: 'Missing required fields' });
    }
    
    const query = `
        SELECT 
            s.id,
            s.first_name,
            s.last_name,
            ps.day_of_week,
            ps.pickup_time,
            ps.pickup_location
        FROM students s
        LEFT JOIN pickup_schedules ps ON s.id = ps.student_id
        WHERE s.first_name = $1 AND s.last_name = $2 AND s.parent_email = $3
        ORDER BY 
            CASE ps.day_of_week
                WHEN 'Monday' THEN 1
                WHEN 'Tuesday' THEN 2
                WHEN 'Wednesday' THEN 3
                WHEN 'Thursday' THEN 4
                WHEN 'Friday' THEN 5
            END
    `;
    
    try {
        const result = await pool.query(query, [firstName, lastName, parentEmail]);
        
        if (result.rows.length === 0) {
            return res.json({ 
                success: false, 
                message: 'Student not found. Please check the name and email address.' 
            });
        }
        
        res.json({ success: true, schedules: result.rows });
    } catch (err) {
        console.error('Error fetching student schedule:', err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});


// API route to update a student's schedule
app.post('/api/update-schedule', async (req, res) => {
    const { studentId, schedules } = req.body;
    
    if (!studentId) {
        return res.json({ success: false, message: 'Student ID is required' });
    }
    
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        // First, delete all existing schedules for this student
        await client.query('DELETE FROM pickup_schedules WHERE student_id = $1', [studentId]);
        
        // If no new schedules provided, just return success
        if (!schedules || schedules.length === 0) {
            await client.query('COMMIT');
            return res.json({ success: true, message: 'All schedules removed successfully' });
        }
        
        // Insert new schedules
        for (const schedule of schedules) {
            const { day, time, location } = schedule;
            await client.query(
                'INSERT INTO pickup_schedules (student_id, day_of_week, pickup_time, pickup_location) VALUES ($1, $2, $3, $4)',
                [studentId, day, time, location]
            );
        }
        
        await client.query('COMMIT');
        res.json({ success: true, message: 'Schedule updated successfully' });
        
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error updating schedule:', err);
        res.json({ success: false, message: 'Failed to update schedule' });
    } finally {
        client.release();
    }
});

// API route to update student contact information
app.post('/api/update-student-info', async (req, res) => {
    const { studentId, parentEmail, parentPhone } = req.body;
    
    if (!studentId) {
        return res.json({ success: false, message: 'Student ID is required' });
    }
    
    const query = `
        UPDATE students 
        SET parent_email = $1, parent_phone = $2 
        WHERE id = $3
    `;
    
    try {
        const result = await pool.query(query, [parentEmail, parentPhone, studentId]);
        
        if (result.rowCount === 0) {
            return res.json({ success: false, message: 'Student not found' });
        }
        
        res.json({ success: true, message: 'Student information updated successfully' });
    } catch (err) {
        console.error('Error updating student info:', err);
        res.status(500).json({ success: false, message: 'Failed to update student information' });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});