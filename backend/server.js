import express from 'express';
import dotenv from 'dotenv';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import mongoSanitize from 'express-mongo-sanitize';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cron from 'node-cron';
import mongoose from 'mongoose';
import {
  initializeFirebaseRealtime,
  isFirebaseRealtimeEnabled,
  updateActiveOrderLocation
} from './shared/services/firebaseRealtimeService.js';

// Load environment variables
dotenv.config();

// Import configurations
import { connectDB, waitForDBConnection, requireDbConnection, isDbConnected } from './config/database.js';
import { connectRedis } from './config/redis.js';

// Import middleware
import { errorHandler } from './shared/middleware/errorHandler.js';

// Import routes
import authRoutes from './modules/auth/index.js';
import userRoutes from './modules/user/index.js';
import restaurantRoutes from './modules/restaurant/index.js';
import deliveryRoutes from './modules/delivery/index.js';
import orderRoutes from './modules/order/index.js';
import paymentRoutes from './modules/payment/index.js';
import menuRoutes from './modules/menu/index.js';
import campaignRoutes from './modules/campaign/index.js';
import notificationRoutes from './modules/notification/index.js';
import analyticsRoutes from './modules/analytics/index.js';
import adminRoutes from './modules/admin/index.js';
import categoryPublicRoutes from './modules/admin/routes/categoryPublicRoutes.js';
import feeSettingsPublicRoutes from './modules/admin/routes/feeSettingsPublicRoutes.js';
import envPublicRoutes from './modules/admin/routes/envPublicRoutes.js';
import aboutPublicRoutes from './modules/admin/routes/aboutPublicRoutes.js';
import businessSettingsPublicRoutes from './modules/admin/routes/businessSettingsPublicRoutes.js';
import contactPublicRoutes from './modules/admin/routes/contactPublicRoutes.js';
import termsPublicRoutes from './modules/admin/routes/termsPublicRoutes.js';
import privacyPublicRoutes from './modules/admin/routes/privacyPublicRoutes.js';
import refundPublicRoutes from './modules/admin/routes/refundPublicRoutes.js';
import shippingPublicRoutes from './modules/admin/routes/shippingPublicRoutes.js';
import cancellationPublicRoutes from './modules/admin/routes/cancellationPublicRoutes.js';
import feedbackPublicRoutes from './modules/admin/routes/feedbackPublicRoutes.js';
import feedbackExperiencePublicRoutes from './modules/admin/routes/feedbackExperiencePublicRoutes.js';
import safetyEmergencyPublicRoutes from './modules/admin/routes/safetyEmergencyPublicRoutes.js';
import zonePublicRoutes from './modules/admin/routes/zonePublicRoutes.js';
import subscriptionRoutes from './modules/subscription/index.js';
import uploadModuleRoutes from './modules/upload/index.js';
import locationRoutes from './modules/location/index.js';
import heroBannerRoutes from './modules/heroBanner/index.js';
import groceryRoutes from './modules/grocery/index.js';


// Validate required environment variables
const requiredEnvVars = ['JWT_SECRET', 'MONGODB_URI'];
const missingEnvVars = [];

requiredEnvVars.forEach(varName => {
  let value = process.env[varName];

  // Remove quotes if present (dotenv sometimes includes them)
  if (value && typeof value === 'string') {
    value = value.trim();
    // Remove surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).trim();
    }
  }

  // Update the env var with cleaned value
  if (value) {
    process.env[varName] = value;
  }

  // Check if valid
  if (!value || value === '' || (varName === 'JWT_SECRET' && value.includes('your-super-secret'))) {
    missingEnvVars.push(varName);
  }
});

if (missingEnvVars.length > 0) {
  console.error('❌ Missing or invalid required environment variables:');
  missingEnvVars.forEach(varName => {
    console.error(`   - ${varName}${varName === 'JWT_SECRET' ? ' (must be set to a secure value, not the placeholder)' : ''}`);
  });
  console.error('\nPlease update your .env file with valid values.');
  console.error('You can copy .env.example to .env and update the values.\n');
  process.exit(1);
}

const firebaseRealtimeInit = await initializeFirebaseRealtime({ allowDbLookup: false });
if (firebaseRealtimeInit.initialized) {
  console.log('Firebase Realtime Database initialized');
} else {
  console.warn(
    `Firebase Realtime Database not initialized (${firebaseRealtimeInit.reason || 'unknown_reason'}). ` +
    'Realtime tracking will fall back to Socket.IO/Mongo until FIREBASE_DATABASE_URL and admin credentials are configured.'
  );
}

// Initialize Express app
const app = express();
const httpServer = createServer(app);
const trustProxyConfig = process.env.TRUST_PROXY;
if (typeof trustProxyConfig === 'string' && trustProxyConfig.trim() !== '') {
  const normalizedTrustProxy = trustProxyConfig.trim().toLowerCase();
  if (normalizedTrustProxy === 'true') {
    app.set('trust proxy', true);
  } else if (normalizedTrustProxy === 'false') {
    app.set('trust proxy', false);
  } else if (!Number.isNaN(Number(normalizedTrustProxy))) {
    app.set('trust proxy', Number(normalizedTrustProxy));
  } else {
    app.set('trust proxy', trustProxyConfig.trim());
  }
} else {
  app.set('trust proxy', 1);
}

const parseForwardedFor = (value) => {
  if (!value || typeof value !== 'string') return null;
  const first = value.split(',')[0]?.trim();
  return first || null;
};

const getClientIpForRateLimit = (req) => {
  // Cloudflare forwards the original client IP here.
  const cfConnectingIp = req.headers['cf-connecting-ip'];
  if (typeof cfConnectingIp === 'string' && cfConnectingIp.trim()) {
    return cfConnectingIp.trim();
  }

  // Fallback for Nginx/LB chains.
  const xForwardedFor = req.headers['x-forwarded-for'];
  if (Array.isArray(xForwardedFor) && xForwardedFor.length > 0) {
    const parsed = parseForwardedFor(xForwardedFor[0]);
    if (parsed) return parsed;
  }
  if (typeof xForwardedFor === 'string') {
    const parsed = parseForwardedFor(xForwardedFor);
    if (parsed) return parsed;
  }

  return req.ip || req.socket?.remoteAddress || 'unknown';
};

const rateLimitKeyGenerator = (req) => getClientIpForRateLimit(req);
const isProduction = process.env.NODE_ENV === 'production';
const verboseLocationStreamLogs = process.env.LOG_LOCATION_STREAM === 'true';

const parseOriginList = (...values) => {
  const origins = [];
  values.forEach((value) => {
    if (!value || typeof value !== 'string') return;
    value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
      .forEach((v) => origins.push(v));
  });
  return origins;
};

const configuredOrigins = [
  ...parseOriginList(
    process.env.CORS_ORIGINS,
    process.env.CORS_ORIGIN,
    process.env.FRONTEND_URL
  ),

  'https://mobasket.in',
  'https://www.mobasket.in',
  'https://order.mobasket.in',
  'https://www.order.mobasket.in',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174'
];

const allowedOrigins = [...new Set(configuredOrigins.filter(Boolean))];

const defaultAllowedOriginPatterns = [
  /^https:\/\/.*\.vercel\.app$/i
];

const envAllowedOriginPatterns = parseOriginList(process.env.CORS_ALLOWED_ORIGIN_REGEX)
  .map((pattern) => {
    try {
      return new RegExp(pattern, 'i');
    } catch {
      console.warn(`Invalid CORS_ALLOWED_ORIGIN_REGEX pattern ignored: ${pattern}`);
      return null;
    }
  })
  .filter(Boolean);

const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;

  if (process.env.NODE_ENV !== 'production') {
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) return true;
  }

  if (defaultAllowedOriginPatterns.some((regex) => regex.test(origin))) return true;
  if (envAllowedOriginPatterns.some((regex) => regex.test(origin))) return true;
  return false;
};

const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        console.log(`[Socket.IO CORS] Allowing connection from: ${origin}`);
        callback(null, true);
      } else {
        console.error(`[Socket.IO CORS] Blocking connection from: ${origin} (not in allowlist)`);
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-refresh-token']
  },
  transports: ['polling', 'websocket'], // Polling first, then upgrade to websocket
  allowEIO3: true, // Allow Engine.IO v3 clients for compatibility
  path: '/socket.io/', // Explicitly set Socket.IO path
  connectTimeout: 45000, // Increase connection timeout
  pingTimeout: 20000,
  pingInterval: 25000
});

// Attach io to app so routes/controllers can broadcast (e.g. delivery location -> order tracking)
app.set('io', io);

// Export getIO function for use in other modules
export function getIO() {
  return io;
}

const extractSocketRoomId = (payload, keyHints = []) => {
  if (!payload) return '';
  if (typeof payload === 'string' || typeof payload === 'number') return String(payload).trim();
  if (typeof payload !== 'object') return String(payload).trim();

  for (const key of keyHints) {
    if (payload[key]) return String(payload[key]).trim();
  }

  if (payload._id) return String(payload._id).trim();
  if (payload.id) return String(payload.id).trim();
  return '';
};

// Restaurant namespace for order notifications
const restaurantNamespace = io.of('/restaurant');

// Add connection error handling before connection event
restaurantNamespace.use((socket, next) => {
  try {
    // Log connection attempt
    console.log('🍽️ Restaurant connection attempt:', {
      socketId: socket.id,
      auth: socket.handshake.auth,
      query: socket.handshake.query,
      origin: socket.handshake.headers.origin,
      userAgent: socket.handshake.headers['user-agent']
    });

    // Allow all connections - authentication can be handled later if needed
    // The token is passed in auth.token but we don't validate it here
    // to avoid blocking connections unnecessarily
    next();
  } catch (error) {
    console.error('❌ Error in restaurant namespace middleware:', error);
    next(error);
  }
});

restaurantNamespace.on('connection', (socket) => {
  console.log('🍽️ Restaurant client connected:', socket.id);
  console.log('🍽️ Socket auth:', socket.handshake.auth);
  console.log('🍽️ Socket query:', socket.handshake.query);
  console.log('🍽️ Socket headers:', socket.handshake.headers);

  // Restaurant joins their room
  socket.on('join-restaurant', (payload) => {
    const restaurantId = extractSocketRoomId(payload, ['restaurantId', 'storeId']);
    if (restaurantId) {
      // Normalize restaurantId to string (handle both ObjectId and string)
      const normalizedRestaurantId = restaurantId?.toString() || restaurantId;
      const room = `restaurant:${normalizedRestaurantId}`;

      // Log room join attempt with detailed info
      console.log(`🍽️ Restaurant attempting to join room:`, {
        restaurantId: restaurantId,
        normalizedRestaurantId: normalizedRestaurantId,
        room: room,
        socketId: socket.id,
        socketAuth: socket.handshake.auth,
        rawPayload: payload
      });

      socket.join(room);
      const roomSize = restaurantNamespace.adapter.rooms.get(room)?.size || 0;
      console.log(`✅ Restaurant ${normalizedRestaurantId} joined room: ${room}`);
      console.log(`📊 Total sockets in room ${room}: ${roomSize}`);

      // Also join with ObjectId format if it's a valid ObjectId (for compatibility)
      if (mongoose.Types.ObjectId.isValid(normalizedRestaurantId)) {
        const objectIdRoom = `restaurant:${new mongoose.Types.ObjectId(normalizedRestaurantId).toString()}`;
        if (objectIdRoom !== room) {
          socket.join(objectIdRoom);
          const objectIdRoomSize = restaurantNamespace.adapter.rooms.get(objectIdRoom)?.size || 0;
          console.log(`✅ Restaurant also joined ObjectId room: ${objectIdRoom} (${objectIdRoomSize} sockets)`);
        }
      }

      // Send confirmation back to client
      socket.emit('restaurant-room-joined', {
        restaurantId: normalizedRestaurantId,
        room: room,
        socketId: socket.id
      });

      // Log all rooms this socket is now in
      const socketRooms = Array.from(socket.rooms).filter(r => r.startsWith('restaurant:'));
      console.log(`📋 Socket ${socket.id} is now in restaurant rooms:`, socketRooms);
    } else {
      console.warn('⚠️ Restaurant tried to join without restaurantId');
      console.warn('⚠️ Socket ID:', socket.id);
      console.warn('⚠️ Socket auth:', socket.handshake.auth);
      console.warn('⚠️ Join payload:', payload);
    }
  });

  socket.on('disconnect', () => {
    console.log('🍽️ Restaurant client disconnected:', socket.id);
  });

  // Handle connection errors
  socket.on('error', (error) => {
    console.error('🍽️ Restaurant socket error:', error);
  });
});

// Grocery-store namespace for store order notifications
const groceryStoreNamespace = io.of('/grocery-store');

groceryStoreNamespace.use((socket, next) => {
  try {
    console.log('🛒 Grocery-store connection attempt:', {
      socketId: socket.id,
      auth: socket.handshake.auth,
      query: socket.handshake.query,
      origin: socket.handshake.headers.origin,
      userAgent: socket.handshake.headers['user-agent']
    });
    next();
  } catch (error) {
    console.error('❌ Error in grocery-store namespace middleware:', error);
    next(error);
  }
});

groceryStoreNamespace.on('connection', (socket) => {
  console.log('🛒 Grocery-store client connected:', socket.id);

  socket.on('join-grocery-store', (payload) => {
    const storeId = extractSocketRoomId(payload, ['storeId', 'restaurantId']);
    if (!storeId) {
      console.warn('⚠️ Grocery-store tried to join without storeId');
      console.warn('⚠️ Join payload:', payload);
      return;
    }

    const normalizedStoreId = storeId?.toString() || storeId;
    const room = `grocery-store:${normalizedStoreId}`;

    socket.join(room);
    const roomSize = groceryStoreNamespace.adapter.rooms.get(room)?.size || 0;
    console.log(`✅ Grocery-store ${normalizedStoreId} joined room: ${room}`);
    console.log(`📊 Total sockets in room ${room}: ${roomSize}`);

    if (mongoose.Types.ObjectId.isValid(normalizedStoreId)) {
      const objectIdRoom = `grocery-store:${new mongoose.Types.ObjectId(normalizedStoreId).toString()}`;
      if (objectIdRoom !== room) {
        socket.join(objectIdRoom);
      }
    }

    socket.emit('grocery-store-room-joined', {
      storeId: normalizedStoreId,
      room,
      socketId: socket.id
    });
  });

  socket.on('disconnect', () => {
    console.log('🛒 Grocery-store client disconnected:', socket.id);
  });

  socket.on('error', (error) => {
    console.error('🛒 Grocery-store socket error:', error);
  });
});

// Delivery namespace for order assignments
const deliveryNamespace = io.of('/delivery');

deliveryNamespace.on('connection', (socket) => {
  console.log('🚴 Delivery client connected:', socket.id);
  console.log('🚴 Socket auth:', socket.handshake.auth);

  // Delivery boy joins their room
  socket.on('join-delivery', (deliveryId) => {
    if (deliveryId) {
      // Normalize deliveryId to string (handle both ObjectId and string)
      const normalizedDeliveryId = deliveryId?.toString() || deliveryId;
      const room = `delivery:${normalizedDeliveryId}`;

      socket.join(room);
      console.log(`🚴 Delivery partner ${normalizedDeliveryId} joined room: ${room}`);
      console.log(`🚴 Total sockets in room ${room}:`, deliveryNamespace.adapter.rooms.get(room)?.size || 0);

      // Also join with ObjectId format if it's a valid ObjectId (for compatibility)
      if (mongoose.Types.ObjectId.isValid(normalizedDeliveryId)) {
        const objectIdRoom = `delivery:${new mongoose.Types.ObjectId(normalizedDeliveryId).toString()}`;
        if (objectIdRoom !== room) {
          socket.join(objectIdRoom);
          console.log(`🚴 Delivery partner also joined ObjectId room: ${objectIdRoom}`);
        }
      }

      // Send confirmation back to client
      socket.emit('delivery-room-joined', {
        deliveryId: normalizedDeliveryId,
        room: room,
        socketId: socket.id
      });
    } else {
      console.warn('⚠️ Delivery partner tried to join without deliveryId');
    }
  });

  socket.on('disconnect', () => {
    console.log('🚴 Delivery client disconnected:', socket.id);
  });

  // Handle connection errors
  socket.on('error', (error) => {
    console.error('🚴 Delivery socket error:', error);
  });
});

// Make io available to routes
app.set('io', io);

// Connect to databases
import { initializeCloudinary } from './config/cloudinary.js';

// Connect to databases
connectDB().then(() => {
  // Initialize Cloudinary after DB connection
  initializeCloudinary().catch(err => console.error('Failed to initialize Cloudinary:', err));
  initializeFirebaseRealtime({ allowDbLookup: true })
    .then((init) => {
      if (init.initialized) {
        console.log('Firebase Realtime Database initialized from ENV Setup');
      } else {
        console.warn(
          `Firebase Realtime Database not initialized from ENV Setup (${init.reason || 'unknown_reason'}).`
        );
      }
    })
    .catch((err) => console.error('Failed to initialize Firebase Realtime from ENV Setup:', err));
});

// Redis connection is optional - only connects if REDIS_ENABLED=true
connectRedis().catch(() => {
  // Silently handle Redis connection failures
  // The app works without Redis
});

// Security middleware
app.use(helmet());
// CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
    } else {
      console.warn(`[HTTP CORS] Blocked origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-refresh-token']
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Data sanitization
app.use(mongoSanitize());

// Rate limiting (disabled in development mode)
if (process.env.NODE_ENV === 'production') {
  const publicBootstrapGetPaths = new Set([
    '/env/public',
    '/business-settings/public',
    '/fee-settings/public',
    '/categories/public',
    '/about/public',
    '/terms/public',
    '/privacy/public',
    '/refund/public',
    '/shipping/public',
    '/cancellation/public',
    '/zones/detect'
  ]);
  const isLocationUpdateRoute = (req) =>
    req.method === 'PUT' && req.path === '/user/location';
  const isAdminEnvSaveRoute = (req) =>
    req.method === 'POST' && req.path === '/admin/env-variables';
  const isUploadMediaRoute = (req) =>
    req.method === 'POST' && req.path === '/upload/media';
  const isDeliverySignupRoute = (req) =>
    req.method === 'POST' &&
    ['/delivery/signup/details', '/delivery/signup/documents'].includes(req.path);
  const isOtpSendRoute = (req) =>
    req.method === 'POST' &&
    [
      '/auth/send-otp',
      '/restaurant/auth/send-otp',
      '/delivery/auth/send-otp',
      '/grocery/store/auth/send-otp'
    ].includes(req.path);
  const isOtpVerifyRoute = (req) =>
    req.method === 'POST' &&
    [
      '/auth/verify-otp',
      '/restaurant/auth/verify-otp',
      '/delivery/auth/verify-otp',
      '/grocery/store/auth/verify-otp'
    ].includes(req.path);
  const isPublicBootstrapRoute = (req) =>
    req.method === 'GET' && publicBootstrapGetPaths.has(req.path);
  const isReverseGeocodeRoute = (req) =>
    req.method === 'GET' && req.path === '/location/reverse';

  const isGlobalApiRateLimitEnabled =
    String(process.env.ENABLE_GLOBAL_API_RATE_LIMIT || 'false').toLowerCase() === 'true';

  if (isGlobalApiRateLimitEnabled) {
    const limiter = rateLimit({
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
      max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100, // limit each IP to 100 requests per windowMs
      message: 'Too many requests from this IP, please try again later.',
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: rateLimitKeyGenerator,
      // These routes have dedicated controls and should not consume the generic API bucket.
      skip: (req) =>
        isLocationUpdateRoute(req) ||
        isAdminEnvSaveRoute(req) ||
        isUploadMediaRoute(req) ||
        isDeliverySignupRoute(req) ||
        isOtpSendRoute(req) ||
        isOtpVerifyRoute(req) ||
        isPublicBootstrapRoute(req) ||
        isReverseGeocodeRoute(req),
      // Avoid proxy validation exceptions in reverse-proxy deployments.
      validate: false
    });

    app.use('/api/', limiter);
    console.log('[rate-limit] Global API rate limiter enabled');
  } else {
    console.log('[rate-limit] Global API rate limiter disabled (using route-specific limiters only)');
  }

  const otpIpLimiter = rateLimit({
    windowMs: parseInt(process.env.OTP_IP_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    max: parseInt(process.env.OTP_IP_RATE_LIMIT_MAX_REQUESTS) || 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: rateLimitKeyGenerator,
    validate: false,
    handler: (req, res) => {
      const resetTime = req.rateLimit?.resetTime ? new Date(req.rateLimit.resetTime).getTime() : null;
      const retryAfterSeconds = resetTime
        ? Math.max(1, Math.ceil((resetTime - Date.now()) / 1000))
        : Math.ceil((parseInt(process.env.OTP_IP_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000) / 1000);

      res.set('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        success: false,
        message: 'Too many OTP attempts from this network. Please try again later.',
        errors: { retryAfterSeconds }
      });
    }
  });

  app.use('/api/auth/send-otp', otpIpLimiter);
  app.use('/api/restaurant/auth/send-otp', otpIpLimiter);
  app.use('/api/delivery/auth/send-otp', otpIpLimiter);
  app.use('/api/grocery/store/auth/send-otp', otpIpLimiter);

  const otpVerifyIpLimiter = rateLimit({
    windowMs: parseInt(process.env.OTP_VERIFY_IP_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    max: parseInt(process.env.OTP_VERIFY_IP_RATE_LIMIT_MAX_REQUESTS) || 120,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: rateLimitKeyGenerator,
    validate: false,
    message: 'Too many OTP verification attempts from this network. Please try again later.'
  });

  app.use('/api/auth/verify-otp', otpVerifyIpLimiter);
  app.use('/api/restaurant/auth/verify-otp', otpVerifyIpLimiter);
  app.use('/api/delivery/auth/verify-otp', otpVerifyIpLimiter);
  app.use('/api/grocery/store/auth/verify-otp', otpVerifyIpLimiter);

  const adminEnvLimiter = rateLimit({
    windowMs: parseInt(process.env.ADMIN_ENV_RATE_LIMIT_WINDOW_MS) || 5 * 60 * 1000, // 5 minutes
    max: parseInt(process.env.ADMIN_ENV_RATE_LIMIT_MAX_REQUESTS) || 20,
    message: 'Too many environment update attempts. Please try again shortly.',
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: rateLimitKeyGenerator,
    // Avoid proxy validation exceptions in reverse-proxy deployments.
    validate: false
  });

  app.use('/api/admin/env-variables', adminEnvLimiter);

  // Public contact form: unauthenticated and writes to the database, so it is
  // capped per network to keep it from being used as a spam channel.
  const contactLimiter = rateLimit({
    windowMs: parseInt(process.env.CONTACT_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    max: parseInt(process.env.CONTACT_RATE_LIMIT_MAX_REQUESTS) || 5,
    message: 'Too many messages sent from this network. Please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: rateLimitKeyGenerator,
    validate: false
  });

  app.use('/api/contact', contactLimiter);

  const uploadIpLimiter = rateLimit({
    windowMs: parseInt(process.env.UPLOAD_IP_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    max: parseInt(process.env.UPLOAD_IP_RATE_LIMIT_MAX_REQUESTS) || 240,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: rateLimitKeyGenerator,
    validate: false,
    message: 'Too many upload requests from this network. Please try again in a few minutes.'
  });

  app.use('/api/upload/media', uploadIpLimiter);

  const deliverySignupIpLimiter = rateLimit({
    windowMs: parseInt(process.env.DELIVERY_SIGNUP_IP_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    max: parseInt(process.env.DELIVERY_SIGNUP_IP_RATE_LIMIT_MAX_REQUESTS) || 180,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: rateLimitKeyGenerator,
    validate: false,
    message: 'Too many delivery signup attempts from this network. Please try again shortly.'
  });

  app.use('/api/delivery/signup/details', deliverySignupIpLimiter);
  app.use('/api/delivery/signup/documents', deliverySignupIpLimiter);

  const reverseGeocodeIpLimiter = rateLimit({
    windowMs: parseInt(process.env.LOCATION_REVERSE_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    max: parseInt(process.env.LOCATION_REVERSE_RATE_LIMIT_MAX_REQUESTS) || 1200,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: rateLimitKeyGenerator,
    validate: false,
    message: 'Too many reverse geocode requests from this network. Please try again shortly.'
  });

  app.use('/api/location/reverse', reverseGeocodeIpLimiter);
  console.log('Rate limiting enabled (production mode)');
} else {
  console.log('Rate limiting disabled (development mode)');
}

// Health check route
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Mongo is required for API operations; fail fast during outages.
app.use('/api', requireDbConnection);

// API routes
app.use('/api/auth', (req, res, next) => {
  // Prevent stale auth responses in WebView/browser caches.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
app.use('/api', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/restaurant', restaurantRoutes);
app.use('/api/delivery', deliveryRoutes);
app.use('/api/order', orderRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/menu', menuRoutes);
app.use('/api/campaign', campaignRoutes);
app.use('/api/notification', notificationRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', categoryPublicRoutes);
app.use('/api', feeSettingsPublicRoutes);
app.use('/api/env', envPublicRoutes);
app.use('/api', aboutPublicRoutes);
app.use('/api', businessSettingsPublicRoutes);
app.use('/api', contactPublicRoutes);
app.use('/api', termsPublicRoutes);
app.use('/api', privacyPublicRoutes);
app.use('/api', refundPublicRoutes);
app.use('/api', shippingPublicRoutes);
app.use('/api', cancellationPublicRoutes);
app.use('/api', feedbackPublicRoutes);
app.use('/api', feedbackExperiencePublicRoutes);
app.use('/api', safetyEmergencyPublicRoutes);
app.use('/api', zonePublicRoutes);
app.use('/api/subscription', subscriptionRoutes);
app.use('/api', uploadModuleRoutes);
app.use('/api/location', locationRoutes);
app.use('/api', heroBannerRoutes);
app.use('/api/grocery', groceryRoutes);

// 404 handler - but skip Socket.IO paths
app.use((req, res, next) => {
  // Skip Socket.IO paths - Socket.IO handles its own routing
  if (req.path.startsWith('/socket.io/') || req.path.startsWith('/restaurant') || req.path.startsWith('/delivery')) {
    return next();
  }

  // Log 404 errors for debugging (especially for admin routes)
  if (req.path.includes('/admin') || req.path.includes('refund')) {
    console.error('❌ [404 HANDLER] Route not found:', {
      method: req.method,
      path: req.path,
      url: req.url,
      originalUrl: req.originalUrl,
      baseUrl: req.baseUrl,
      route: req.route?.path,
      registeredRoutes: 'Check server startup logs for route registration'
    });
    console.error('💡 [404 HANDLER] Expected route: POST /api/admin/refund-requests/:orderId/process');
    console.error('💡 [404 HANDLER] Make sure:');
    console.error('   1. Backend server has been restarted');
    console.error('   2. Route is registered (check startup logs)');
    console.error('   3. Authentication token is valid');
  }

  res.status(404).json({
    success: false,
    message: 'Route not found',
    path: req.path,
    method: req.method,
    expectedRoute: req.path.includes('refund') ? 'POST /api/admin/refund-requests/:orderId/process' : undefined
  });
});

// Error handler (must be last)
app.use(errorHandler);

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  const ORDER_ALIAS_CACHE_TTL_MS = 30000;
  const orderAliasCache = new Map();

  const getCachedAliases = (rawOrderId) => {
    const key = String(rawOrderId || '').trim();
    if (!key) return null;
    const cached = orderAliasCache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.timestamp > ORDER_ALIAS_CACHE_TTL_MS) {
      orderAliasCache.delete(key);
      return null;
    }
    return cached.aliases;
  };

  const setCachedAliases = (aliases) => {
    if (!Array.isArray(aliases) || aliases.length === 0) return;
    const uniqueAliases = Array.from(new Set(aliases.map((alias) => String(alias || '').trim()).filter(Boolean)));
    const payload = { aliases: uniqueAliases, timestamp: Date.now() };
    uniqueAliases.forEach((alias) => orderAliasCache.set(alias, payload));
  };

  const resolveOrderByAnyId = async (rawOrderId, includeDeliveryLocation = false) => {
    const input = String(rawOrderId || '').trim();
    if (!input) return { order: null, aliases: [] };
    if (!isDbConnected()) return { order: null, aliases: [input] };

    const { default: Order } = await import('./modules/order/models/Order.js');

    const query = mongoose.Types.ObjectId.isValid(input) && input.length === 24
      ? { $or: [{ _id: input }, { orderId: input }] }
      : { orderId: input };

    let orderQuery = Order.findOne(query).select('_id orderId deliveryPartnerId assignmentInfo.deliveryPartnerId');
    if (includeDeliveryLocation) {
      orderQuery = orderQuery.populate({
        path: 'deliveryPartnerId',
        select: 'availability.currentLocation'
      });
    }

    const order = await orderQuery.lean();
    if (!order) {
      return { order: null, aliases: [input] };
    }

    if (
      includeDeliveryLocation &&
      !order?.deliveryPartnerId?.availability?.currentLocation &&
      order?.assignmentInfo?.deliveryPartnerId
    ) {
      try {
        const { default: Delivery } = await import('./modules/delivery/models/Delivery.js');
        const fallbackPartner = await Delivery.findById(order.assignmentInfo.deliveryPartnerId)
          .select('availability.currentLocation')
          .lean();
        if (fallbackPartner?.availability?.currentLocation) {
          order.deliveryPartnerResolvedLocation = fallbackPartner.availability.currentLocation;
        }
      } catch (fallbackLookupError) {
        console.warn('Fallback delivery-partner location lookup failed:', fallbackLookupError.message);
      }
    }

    const aliases = Array.from(new Set([input, order._id?.toString(), order.orderId].filter(Boolean)));
    setCachedAliases(aliases);
    return { order, aliases };
  };

  const getOrderCurrentLocation = (orderDoc) => {
    const partnerLocation =
      orderDoc?.deliveryPartnerId?.availability?.currentLocation ||
      orderDoc?.deliveryPartnerResolvedLocation ||
      null;

    if (partnerLocation?.coordinates?.length >= 2) {
      return partnerLocation;
    }

    // Fallback: some flows persist live location on order.deliveryState.currentLocation
    // (lat/lng object) rather than partner availability GeoJSON coordinates.
    const stateLocation = orderDoc?.deliveryState?.currentLocation;
    if (
      Number.isFinite(Number(stateLocation?.lat)) &&
      Number.isFinite(Number(stateLocation?.lng))
    ) {
      return {
        coordinates: [Number(stateLocation.lng), Number(stateLocation.lat)],
        bearing: Number(stateLocation.bearing || 0)
      };
    }

    return null;
  };

  const resolveAliasesFast = async (rawOrderId) => {
    const input = String(rawOrderId || '').trim();
    if (!input) return [];
    const cachedAliases = getCachedAliases(input);
    if (cachedAliases && cachedAliases.length > 0) return cachedAliases;
    const { aliases } = await resolveOrderByAnyId(input, false);
    return aliases?.length ? aliases : [input];
  };

  // Delivery boy sends location update
  socket.on('update-location', (data) => {
    const processLocationUpdate = async () => {
      // Validate data
      if (!data.orderId || typeof data.lat !== 'number' || typeof data.lng !== 'number') {
        console.error('Invalid location update data:', data);
        return;
      }

      // Broadcast location to customer tracking this order (only to specific room)
      // Format: { orderId, lat, lng, heading }
      const locationData = {
        orderId: data.orderId,
        lat: data.lat,
        lng: data.lng,
        heading: data.heading || 0,
        timestamp: Date.now()
      };

      const aliases = await resolveAliasesFast(data.orderId);
      aliases.forEach((alias) => {
        io.to(`order:${alias}`).emit(`location-receive-${alias}`, {
          ...locationData,
          orderId: alias
        });
      });

      try {
        const firebaseAliases = aliases?.length
          ? aliases
          : [String(data.orderId || '').trim()].filter(Boolean);
        await Promise.all(
          firebaseAliases.map((alias) =>
            updateActiveOrderLocation(alias, {
              lat: data.lat,
              lng: data.lng,
              bearing: data.heading || 0,
              speed: typeof data.speed === 'number' ? data.speed : undefined
            })
          )
        );
      } catch (firebaseErr) {
        console.warn('Firebase socket location sync failed:', firebaseErr.message);
      }

      if (!isProduction || verboseLocationStreamLogs) {
        console.log(`📍 Location broadcasted to order room ${data.orderId}:`, {
          lat: locationData.lat,
          lng: locationData.lng,
          heading: locationData.heading
        });

        console.log(`📍 Location update for order ${data.orderId}:`, {
          lat: data.lat,
          lng: data.lng,
          heading: data.heading
        });
      }
    };

    processLocationUpdate().catch((error) => {
      console.error('Error handling location update:', error);
    });
  });

  // Customer joins order tracking room
  socket.on('join-order-tracking', async (orderId) => {
    if (orderId) {
      const { order, aliases } = await resolveOrderByAnyId(orderId, true);
      const roomsToJoin = aliases?.length ? aliases : [String(orderId)];
      roomsToJoin.forEach((alias) => socket.join(`order:${alias}`));
      console.log(`Customer joined order tracking rooms:`, roomsToJoin);

      // Send current location immediately when customer joins
      try {
        const currentLocation = getOrderCurrentLocation(order);
        if (currentLocation) {
          const coords = currentLocation.coordinates;
          const baseLocationData = {
            lat: coords[1],
            lng: coords[0],
            heading: Number(currentLocation?.bearing || 0),
            timestamp: Date.now()
          };

          roomsToJoin.forEach((alias) => {
            socket.emit(`current-location-${alias}`, {
              ...baseLocationData,
              orderId: alias
            });
          });
          console.log(`📍 Sent current location to customer for order aliases:`, roomsToJoin);
        }
      } catch (error) {
        console.error('Error sending current location:', error.message);
      }
    }
  });

  // Handle request for current location
  socket.on('request-current-location', async (orderId) => {
    if (!orderId) return;

    try {
      const { order, aliases } = await resolveOrderByAnyId(orderId, true);

      const currentLocation = getOrderCurrentLocation(order);
      if (currentLocation) {
        const coords = currentLocation.coordinates;
        const baseLocationData = {
          lat: coords[1],
          lng: coords[0],
          heading: Number(currentLocation?.bearing || 0),
          timestamp: Date.now()
        };

        const emitAliases = aliases?.length ? aliases : [String(orderId)];
        emitAliases.forEach((alias) => {
          socket.emit(`current-location-${alias}`, {
            ...baseLocationData,
            orderId: alias
          });
        });
        console.log(`📍 Sent requested location for order aliases:`, emitAliases);
      }
    } catch (error) {
      console.error('Error fetching current location:', error.message);
    }
  });

  // Delivery boy joins delivery room
  socket.on('join-delivery', (deliveryId) => {
    if (deliveryId) {
      socket.join(`delivery:${deliveryId}`);
      console.log(`Delivery boy joined: ${deliveryId}`);
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Start server only after MongoDB is connected to avoid startup race
const PORT = process.env.PORT || 5000;

const startServer = async () => {
  await waitForDBConnection();

  httpServer.listen(PORT, () => {
    console.log(`Server running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
    console.log(`Firebase Realtime status: ${isFirebaseRealtimeEnabled() ? 'enabled' : 'disabled'}`);
    initializeScheduledTasks();
  });
};

startServer().catch((error) => {
  console.error('Failed to start server:', error?.message || error);
  process.exit(1);
});

// Initialize scheduled tasks
function initializeScheduledTasks() {
  const scheduledTasksEnabled =
    String(process.env.ENABLE_SCHEDULED_TASKS || 'true').toLowerCase() === 'true';
  const allowAllPm2Instances =
    String(process.env.ALLOW_ALL_PM2_INSTANCES_SCHEDULED_TASKS || 'false').toLowerCase() === 'true';
  const pm2InstanceId = String(
    process.env.NODE_APP_INSTANCE ??
    process.env.pm_id ??
    process.env.PM2_INSTANCE_ID ??
    '0'
  ).trim();
  const isPrimaryPm2Instance = pm2InstanceId === '0';

  if (!scheduledTasksEnabled) {
    console.log('ℹ️ Scheduled tasks disabled via ENABLE_SCHEDULED_TASKS=false');
    return;
  }

  if (!allowAllPm2Instances && !isPrimaryPm2Instance) {
    console.log(`ℹ️ Skipping scheduled tasks on PM2 instance ${pm2InstanceId}; primary instance only`);
    return;
  }

  const runWithoutOverlap = (label, task) => {
    let inFlight = false;

    return async () => {
      if (inFlight) {
        console.warn(`[${label}] Previous run still in progress, skipping this tick`);
        return;
      }

      inFlight = true;
      try {
        await task();
      } finally {
        inFlight = false;
      }
    };
  };

  // Import menu schedule service
  import('./modules/restaurant/services/menuScheduleService.js').then(({ processScheduledAvailability }) => {
    // Run every minute to check for due schedules
    cron.schedule('* * * * *', runWithoutOverlap('Menu Schedule Cron', async () => {
      try {
        const result = await processScheduledAvailability();
        if (result.processed > 0) {
          console.log(`[Menu Schedule Cron] ${result.message}`);
        }
      } catch (error) {
        console.error('[Menu Schedule Cron] Error:', error);
      }
    }));

    console.log('✅ Menu item availability scheduler initialized (runs every minute)');
  }).catch((error) => {
    console.error('❌ Failed to initialize menu schedule service:', error);
  });

  // Import auto-ready service
  import('./modules/order/services/autoReadyService.js').then(({ processAutoReadyOrders }) => {
    // Run every 30 seconds to check for orders that should be marked as ready
    cron.schedule('*/30 * * * * *', runWithoutOverlap('Auto Ready Cron', async () => {
      try {
        const result = await processAutoReadyOrders();
        if (result.processed > 0) {
          console.log(`[Auto Ready Cron] ${result.message}`);
        }
      } catch (error) {
        console.error('[Auto Ready Cron] Error:', error);
      }
    }));

    console.log('✅ Auto-ready order scheduler initialized (runs every 30 seconds)');
  }).catch((error) => {
    console.error('❌ Failed to initialize auto-ready service:', error);
  });

  // Import auto-reject service
  import('./modules/order/services/autoRejectService.js').then(({ processAutoRejectOrders }) => {
    // Run every 30 seconds to check for orders that should be auto-rejected
    cron.schedule('*/30 * * * * *', runWithoutOverlap('Auto Reject Cron', async () => {
      try {
        const result = await processAutoRejectOrders();
        if (result.processed > 0) {
          console.log(`[Auto Reject Cron] ${result.message}`);
        }
      } catch (error) {
        console.error('[Auto Reject Cron] Error:', error);
      }
    }));

    console.log('✅ Auto-reject order scheduler initialized (runs every 30 seconds)');
  }).catch((error) => {
    console.error('❌ Failed to initialize auto-reject service:', error);
  });

  // Import scheduled order activation service
  import('./modules/order/services/scheduledOrderService.js').then(({ processScheduledOrders }) => {
    // Run every 30 seconds to activate orders near the exact scheduled time
    cron.schedule('*/30 * * * * *', runWithoutOverlap('Scheduled Order Cron', async () => {
      try {
        const result = await processScheduledOrders();
        if (result.processed > 0 || result.skipped > 0) {
          console.log(`[Scheduled Order Cron] ${result.message}`);
        }
      } catch (error) {
        console.error('[Scheduled Order Cron] Error:', error);
      }
    }));

    console.log('✅ Scheduled order activation scheduler initialized (runs every 30 seconds)');
  }).catch((error) => {
    console.error('❌ Failed to initialize scheduled order service:', error);
  });
}

const formatProcessError = (errorLike) => {
  if (errorLike instanceof Error) {
    return {
      name: errorLike.name,
      message: errorLike.message,
      stack: errorLike.stack
    };
  }

  return { message: String(errorLike) };
};

// Keep process alive under transient async failures; let route/socket handlers own recovery.
process.on('unhandledRejection', (reason, promise) => {
  console.error('[process] Unhandled Promise Rejection:', {
    reason: formatProcessError(reason),
    promise: promise ? '[object Promise]' : null
  });
});

process.on('uncaughtException', (error) => {
  console.error('[process] Uncaught Exception:', formatProcessError(error));
});

export default app;






