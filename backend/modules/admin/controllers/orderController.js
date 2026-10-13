import Order from '../../order/models/Order.js';
import { successResponse, errorResponse } from '../../../shared/utils/response.js';
import asyncHandler from '../../../shared/middleware/asyncHandler.js';
import { restoreGroceryStockForOrder } from '../../order/services/groceryStockService.js';
import mongoose from 'mongoose';
import fs from 'fs/promises';
import path from 'path';
import OrderEvent from '../../order/models/OrderEvent.js';
import ETALog from '../../order/models/ETALog.js';
import OrderSettlement from '../../order/models/OrderSettlement.js';
import Payment from '../../payment/models/Payment.js';
import AuditLog from '../models/AuditLog.js';

const normalizePlatform = (value) => (value === 'mogrocery' ? 'mogrocery' : 'mofood');
const ORDER_SNAPSHOT_DIR = path.join(process.cwd(), 'cache');
const hasAcceptedRider = (order = null) => {
  const deliveryStateStatus = String(order?.deliveryState?.status || '').toLowerCase();
  const notificationPhase = String(order?.assignmentInfo?.notificationPhase || '').toLowerCase();

  return Boolean(
    order?.deliveryState?.acceptedAt ||
    ['accepted', 'en_route_to_pickup', 'at_pickup', 'en_route_to_delivery', 'at_delivery', 'completed'].includes(deliveryStateStatus) ||
    String(order?.assignmentInfo?.assignedBy || '').toLowerCase() === 'delivery_accept' ||
    notificationPhase === 'accepted' ||
    ['out_for_delivery', 'delivered'].includes(String(order?.status || '').toLowerCase())
  );
};

const getOrderSnapshotPath = (platform) =>
  path.join(ORDER_SNAPSHOT_DIR, `admin-orders-${normalizePlatform(platform)}.json`);

const readOrderSnapshot = async (platform) => {
  try {
    const raw = await fs.readFile(getOrderSnapshotPath(platform), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const filterSnapshotOrders = (orders, query, platform) => {
  const {
    status,
    page = 1,
    limit = 50,
    search,
    fromDate,
    toDate,
    restaurant,
    paymentStatus,
    customer,
    cancelledBy
  } = query;

  let filtered = Array.isArray(orders) ? [...orders] : [];
  const normalizedPlatform = normalizePlatform(platform);
  const restaurantCancellationReasonRegex = /rejected by restaurant|restaurant rejected|restaurant cancelled|restaurant is too busy|item not available|outside delivery area|kitchen closing|technical issue|order not accepted within time limit/i;

  if (status && status !== 'all') {
    let allowedStatuses = [];
    if (normalizedPlatform === 'mogrocery') {
      if (status === 'accepted') allowedStatuses = ['confirmed', 'preparing'];
      else if (status === 'processing') allowedStatuses = ['preparing', 'ready'];
    } else {
      if (status === 'pending') allowedStatuses = ['pending', 'confirmed'];
      else if (status === 'accepted') allowedStatuses = ['preparing'];
      else if (status === 'processing') allowedStatuses = ['ready'];
    }

    if (status === 'scheduled') {
      filtered = filtered.filter((order) => order?.status === 'scheduled');
    } else if (status === 'food-on-the-way') {
      filtered = filtered.filter((order) => order?.status === 'out_for_delivery');
    } else if (status === 'delivered') {
      filtered = filtered.filter((order) => order?.status === 'delivered');
    } else if (status === 'canceled') {
      filtered = filtered.filter((order) => order?.status === 'cancelled');
    } else if (status === 'restaurant-cancelled') {
      filtered = filtered.filter((order) =>
        order?.status === 'cancelled' &&
        (order?.cancelledBy === 'restaurant' || restaurantCancellationReasonRegex.test(String(order?.cancellationReason || '')))
      );
    } else if (status === 'payment-failed') {
      filtered = filtered.filter((order) =>
        String(order?.paymentStatus || '').toLowerCase() === 'failed' ||
        String(order?.orderStatus || '').toLowerCase() === 'payment failed'
      );
    } else if (status === 'offline-payments') {
      filtered = filtered.filter((order) => String(order?.paymentType || '').toLowerCase() === 'cash on delivery');
    } else if (allowedStatuses.length > 0) {
      filtered = filtered.filter((order) => allowedStatuses.includes(String(order?.status || '')));
    } else {
      filtered = filtered.filter((order) => String(order?.status || '') === status);
    }
  }

  if (cancelledBy === 'restaurant') {
    filtered = filtered.filter((order) =>
      order?.status === 'cancelled' &&
      (order?.cancelledBy === 'restaurant' || restaurantCancellationReasonRegex.test(String(order?.cancellationReason || '')))
    );
  }

  if (paymentStatus) {
    const target = String(paymentStatus).toLowerCase();
    filtered = filtered.filter((order) => String(order?.paymentStatus || '').toLowerCase() === target);
  }

  if (restaurant && restaurant !== 'All restaurants') {
    const needle = String(restaurant).toLowerCase();
    filtered = filtered.filter((order) => String(order?.restaurant || '').toLowerCase().includes(needle));
  }

  if (customer && customer !== 'All customers') {
    const needle = String(customer).toLowerCase();
    filtered = filtered.filter((order) => String(order?.customerName || '').toLowerCase().includes(needle));
  }

  if (search) {
    const needle = String(search).toLowerCase();
    filtered = filtered.filter((order) =>
      String(order?.orderId || '').toLowerCase().includes(needle) ||
      String(order?.customerName || '').toLowerCase().includes(needle) ||
      String(order?.customerPhone || '').toLowerCase().includes(needle) ||
      String(order?.restaurant || '').toLowerCase().includes(needle)
    );
  }

  if (fromDate) {
    const startDate = new Date(fromDate);
    startDate.setHours(0, 0, 0, 0);
    filtered = filtered.filter((order) => new Date(order?.createdAt || order?.date || 0) >= startDate);
  }

  if (toDate) {
    const endDate = new Date(toDate);
    endDate.setHours(23, 59, 59, 999);
    filtered = filtered.filter((order) => new Date(order?.createdAt || order?.date || 0) <= endDate);
  }

  const pageNumber = normalizeAdminOrdersPage(page);
  const pageSize = normalizeAdminOrdersLimit(limit);
  const startIndex = (pageNumber - 1) * pageSize;
  const pagedOrders = filtered.slice(startIndex, startIndex + pageSize);

  return {
    orders: pagedOrders,
    pagination: {
      page: pageNumber,
      limit: pageSize,
      total: filtered.length,
      pages: Math.ceil(filtered.length / pageSize)
    }
  };
};

const buildPlatformFallbackFilter = (platform) => {
  if (platform === 'mogrocery') {
    return {
      $or: [
        { restaurantPlatform: 'mogrocery' },
        { platform: 'mogrocery' }
      ]
    };
  }

  // For mofood: exclude only orders that have explicit mogrocery platform markers.
  // Avoid $nor with $regex — those cause full collection scans and timeouts.
  return {
    restaurantPlatform: { $ne: 'mogrocery' },
    platform: { $ne: 'mogrocery' }
  };
};

const buildPlatformPrimaryFilter = (platform) => {
  if (platform === 'mogrocery') {
    return { restaurantPlatform: 'mogrocery' };
  }

  return { restaurantPlatform: 'mofood' };
};

const ADMIN_ORDERS_DEFAULT_LIMIT = 25;
const ADMIN_ORDERS_MAX_LIMIT = 200;

const normalizeAdminOrdersPage = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};

const normalizeAdminOrdersLimit = (value) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return ADMIN_ORDERS_DEFAULT_LIMIT;
  }

  return Math.min(parsed, ADMIN_ORDERS_MAX_LIMIT);
};

const ORDER_MODIFICATION_WINDOW_MS = 2 * 60 * 1000;
const RESTAURANT_ACCEPT_TIMEOUT_MS = 4 * 60 * 1000;
const RESTAURANT_ACCEPT_TIMEOUT_REASON_REGEX = /order not accepted within time limit|did not respond in time/i;

const isRestaurantAcceptTimeoutOrder = (order) => {
  if (!order || order.status !== 'cancelled') return false;
  const reason = String(order.cancellationReason || '');
  return order.cancelledBy === 'restaurant' && RESTAURANT_ACCEPT_TIMEOUT_REASON_REGEX.test(reason);
};

/** Get 2-minute edit/cancel window for customer (MoFood and MoGrocery) */
const getOrderModificationWindow = (order) => {
  const startAtRaw =
    order?.postOrderActions?.modificationWindowStartAt ||
    order?.tracking?.confirmed?.timestamp ||
    order?.createdAt ||
    null;
  let expiresAtRaw = order?.postOrderActions?.modificationWindowExpiresAt || null;
  if (!expiresAtRaw && startAtRaw) {
    expiresAtRaw = new Date(new Date(startAtRaw).getTime() + ORDER_MODIFICATION_WINDOW_MS);
  }
  const startAt = startAtRaw ? new Date(startAtRaw) : null;
  const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : null;
  const remainingMs = expiresAt ? expiresAt.getTime() - Date.now() : 0;
  const isOpen = remainingMs > 0;
  return {
    isOpen,
    remainingSeconds: isOpen ? Math.ceil(remainingMs / 1000) : 0,
    startAt,
    expiresAt
  };
};

const getRestaurantIdsByPlatform = async (platform) => {
  if (platform === 'mogrocery') {
    const GroceryStore = (await import('../../grocery/models/GroceryStore.js')).default;
    const Restaurant = (await import('../../restaurant/models/Restaurant.js')).default;

    const stores = await GroceryStore.find({})
      .select('_id restaurantId')
      .lean();

    // Legacy grocery orders may still point to Restaurant docs with grocery platform.
    const legacyRestaurants = await Restaurant.find({
      platform: { $in: ['mogrocery', 'grocery'] }
    })
      .select('_id restaurantId')
      .lean();

    return [...new Set([...stores, ...legacyRestaurants].flatMap((store) => {
      const ids = [];
      if (store?._id) ids.push(store._id.toString());
      if (store?.restaurantId) ids.push(String(store.restaurantId));
      return ids;
    }))];
  }

  const Restaurant = (await import('../../restaurant/models/Restaurant.js')).default;
  const restaurants = await Restaurant.find({ platform })
    .select('_id restaurantId')
    .lean();

  return [...new Set(restaurants.flatMap((restaurant) => {
    const ids = [];
    if (restaurant?._id) ids.push(restaurant._id.toString());
    if (restaurant?.restaurantId) ids.push(String(restaurant.restaurantId));
    return ids;
  }))];
};

const findOrderByAdminIdentifier = async (id, session = null) => {
  if (mongoose.Types.ObjectId.isValid(id)) {
    const order = await Order.findById(id).session(session);
    if (order) return order;
  }

  return Order.findOne({ orderId: id }).session(session);
};

const getAdminAssignedZoneIds = (admin = null) => {
  if (!admin || String(admin?.role || '').toLowerCase() === 'super_admin') return [];
  return Array.from(
    new Set(
      (Array.isArray(admin?.assignedZoneIds) ? admin.assignedZoneIds : [])
        .map((zone) => String(zone?._id || zone || '').trim())
        .filter(Boolean)
    )
  );
};

const buildAdminZoneAccessCondition = (admin = null) => {
  const assignedZoneIds = getAdminAssignedZoneIds(admin);
  if (assignedZoneIds.length === 0) return null;
  return { 'assignmentInfo.zoneId': { $in: assignedZoneIds } };
};

const canAdminAccessOrder = (admin = null, order = null) => {
  const assignedZoneIds = getAdminAssignedZoneIds(admin);
  if (assignedZoneIds.length === 0) return true;
  const orderZoneId = String(order?.assignmentInfo?.zoneId || '').trim();
  return Boolean(orderZoneId) && assignedZoneIds.includes(orderZoneId);
};

const canAdminDeleteOrders = (admin = null) =>
  String(admin?.role || '').trim().toLowerCase() === 'super_admin';

/**
 * Get all orders for admin
 * GET /api/admin/orders
 * Query params: status, page, limit, search, fromDate, toDate, restaurant, paymentStatus
 */
export const getOrders = asyncHandler(async (req, res) => {
  try {
    const { 
      status, 
      page = 1, 
      limit = 50,
      search,
      fromDate,
      toDate,
      restaurant,
      paymentStatus,
      zone,
      customer,
      cancelledBy,
      platform
    } = req.query;
    const normalizedPage = normalizeAdminOrdersPage(page);
    const normalizedLimit = normalizeAdminOrdersLimit(limit);
    const now = new Date();
    const restaurantCancellationReasonRegex = /rejected by restaurant|restaurant rejected|restaurant cancelled|restaurant is too busy|item not available|outside delivery area|kitchen closing|technical issue|order not accepted within time limit/i;
    const addAndCondition = (condition) => {
      if (!condition) return;
      if (!query.$and) query.$and = [];
      query.$and.push(condition);
    };

    // Build query
    const query = {};
    const normalizedPlatform = platform ? normalizePlatform(platform) : null;
    const useDedicatedPlatformCollection = normalizedPlatform === 'mofood' || normalizedPlatform === 'mogrocery';
    const useLegacyPlatformFilter = !useDedicatedPlatformCollection;
    let platformRestaurantIds = null;
    const adminZoneAccessCondition = buildAdminZoneAccessCondition(req.user);

    addAndCondition(adminZoneAccessCondition);

    if (normalizedPlatform && useLegacyPlatformFilter) {
      if (normalizedPlatform === 'mogrocery') {
        platformRestaurantIds = await getRestaurantIdsByPlatform(normalizedPlatform);
        const groceryFilter = buildPlatformFallbackFilter('mogrocery');

        if (platformRestaurantIds.length > 0) {
          addAndCondition({
            $or: [
              { restaurantId: { $in: platformRestaurantIds } },
              groceryFilter
            ]
          });
        } else {
          addAndCondition(groceryFilter);
        }
      } else {
        // MoFood with fallbacks for legacy rows where platform flags were not persisted.
        addAndCondition(buildPlatformFallbackFilter('mofood'));
      }
    }
    // Status filter
    if (status && status !== 'all') {
      // Map frontend status keys to backend status values
      const statusMap = {
        'scheduled': 'scheduled',
        'pending': 'pending',
        'accepted': 'confirmed',
        // "processing" tab should include both preparing and ready states.
        'processing': ['preparing', 'ready'],
        'food-on-the-way': 'out_for_delivery',
        'delivered': 'delivered',
        'canceled': 'cancelled',
        'restaurant-cancelled': 'cancelled', // Restaurant cancelled orders
        // For payment-failed, we filter by payment status below.
        'payment-failed': null,
        'refunded': 'cancelled', // Refunded orders might be cancelled
        'dine-in': 'dine_in',
        // For offline-payments, we filter by payment method below.
        'offline-payments': null
      };
      
      let mappedStatus = Object.prototype.hasOwnProperty.call(statusMap, status)
        ? statusMap[status]
        : status;

      // MoGrocery approval flow can move directly to "preparing",
      // so Accepted tab should include those records as well.
      if (normalizedPlatform === 'mogrocery') {
        if (status === 'accepted') {
          mappedStatus = ['confirmed', 'preparing'];
        }
      } else if (normalizedPlatform === 'mofood' || !normalizedPlatform) {
        if (status === 'pending') {
          mappedStatus = ['pending', 'confirmed'];
        } else if (status === 'accepted') {
          mappedStatus = ['preparing'];
        } else if (status === 'processing') {
          mappedStatus = ['ready'];
        }
      }

      if (mappedStatus) {
        query.status = Array.isArray(mappedStatus) ? { $in: mappedStatus } : mappedStatus;
      }

      // Scheduled tab should show only future scheduled orders.
      if (status === 'scheduled') {
        query['scheduledDelivery.isScheduled'] = true;
        query['scheduledDelivery.scheduledFor'] = { $gt: now };
      }
      
      // If restaurant-cancelled, filter by cancellation reason
      if (status === 'restaurant-cancelled') {
        addAndCondition({
          $or: [
            { cancelledBy: 'restaurant' },
            { cancellationReason: { $regex: restaurantCancellationReasonRegex } }
          ]
        });
      }

      if (status === 'payment-failed') {
        addAndCondition({
          'payment.status': { $in: ['failed', 'cancelled'] }
        });
      }

      if (status === 'offline-payments') {
        addAndCondition({
          'payment.method': { $in: ['cash', 'cod'] }
        });
      }
    }
    
    // Also handle cancelledBy query parameter (if passed separately)
    if (cancelledBy === 'restaurant') {
      query.status = 'cancelled';
      addAndCondition({
        $or: [
          { cancelledBy: 'restaurant' },
          { cancellationReason: { $regex: restaurantCancellationReasonRegex } }
        ]
      });
    }

    // NOTE: Future scheduled exclusion was removed from the primary query path to avoid
    // expensive scans that can block admin order listing. Scheduled filtering is still
    // handled explicitly when status === 'scheduled'.

    // Payment status filter
    if (paymentStatus) {
      query['payment.status'] = paymentStatus.toLowerCase();
    }

    // Date range filter
    if (fromDate || toDate) {
      query.createdAt = {};
      if (fromDate) {
        const startDate = new Date(fromDate);
        startDate.setHours(0, 0, 0, 0);
        query.createdAt.$gte = startDate;
      }
      if (toDate) {
        const endDate = new Date(toDate);
        endDate.setHours(23, 59, 59, 999);
        query.createdAt.$lte = endDate;
      }
    }

    // Restaurant filter
    if (restaurant && restaurant !== 'All restaurants') {
      // Try to find restaurant by name or ID
      const Restaurant = (await import('../../restaurant/models/Restaurant.js')).default;
      const GroceryStore = (await import('../../grocery/models/GroceryStore.js')).default;
      const baseSearchQuery = {
        $or: [
          { name: { $regex: restaurant, $options: 'i' } },
          { _id: mongoose.Types.ObjectId.isValid(restaurant) ? restaurant : null },
          { restaurantId: restaurant }
        ]
      };

      const restaurantDoc = normalizedPlatform === 'mogrocery'
        ? await GroceryStore.findOne(baseSearchQuery).select('_id restaurantId').lean()
        : await Restaurant.findOne(
            normalizedPlatform
              ? { ...baseSearchQuery, platform: normalizedPlatform }
              : baseSearchQuery
          )
            .select('_id restaurantId')
            .lean();

      if (restaurantDoc) {
        const selectedRestaurantId = restaurantDoc._id?.toString() || String(restaurantDoc.restaurantId || '');
        if (platformRestaurantIds && !platformRestaurantIds.includes(selectedRestaurantId)) {
          query.restaurantId = { $in: [] };
        } else {
          query.restaurantId = selectedRestaurantId;
        }
      }
    }

    // Zone filter
    if (zone && zone !== 'All Zones') {
      // Find zone by name
      const Zone = (await import('../models/Zone.js')).default;
      const zoneDoc = await Zone.findOne({
        name: { $regex: zone, $options: 'i' }
      }).select('_id name').lean();

      if (zoneDoc) {
        query['assignmentInfo.zoneId'] = zoneDoc._id?.toString();
      }
    }

    // Customer filter
    if (customer && customer !== 'All customers') {
      const User = (await import('../../auth/models/User.js')).default;
      const userDoc = await User.findOne({
        name: { $regex: customer, $options: 'i' }
      }).select('_id').lean();

      if (userDoc) {
        query.userId = userDoc._id;
      }
    }

    // Search filter (orderId, customer name, customer phone)
    if (search) {
      query.$or = [
        { orderId: { $regex: search, $options: 'i' } }
      ];

      // If search looks like a phone number, search in customer data
      const phoneRegex = /[\d\s\+\-()]+/;
      if (phoneRegex.test(search)) {
        const User = (await import('../../auth/models/User.js')).default;
        const cleanSearch = search.replace(/\D/g, '');
        const userSearchQuery = { phone: { $regex: cleanSearch, $options: 'i' } };
        if (mongoose.Types.ObjectId.isValid(search)) {
          userSearchQuery._id = search;
        }
        const users = await User.find(userSearchQuery).select('_id').lean();
        const userIds = users.map(u => u._id);
        if (userIds.length > 0) {
          query.$or.push({ userId: { $in: userIds } });
        }
      }

      // Also search by customer name
      const User = (await import('../../auth/models/User.js')).default;
      const usersByName = await User.find({
        name: { $regex: search, $options: 'i' }
      }).select('_id').lean();
      const userIdsByName = usersByName.map(u => u._id);
      if (userIdsByName.length > 0) {
        if (!query.$or) query.$or = [];
        query.$or.push({ userId: { $in: userIdsByName } });
      }

      // Ensure $or array is not empty
      if (query.$or && query.$or.length === 0) {
        delete query.$or;
      }
    }

    // Calculate pagination
    const skip = (normalizedPage - 1) * normalizedLimit;

    const primaryPlatformQuery = normalizedPlatform
      ? { ...query, ...buildPlatformPrimaryFilter(normalizedPlatform) }
      : query;
    const fallbackQuery = normalizedPlatform
      ? { $and: [query, buildPlatformFallbackFilter(normalizedPlatform)] }
      : query;
    const projectionObject = {
      orderId: 1,
      createdAt: 1,
      userId: 1,
      restaurantId: 1,
      restaurantName: 1,
      restaurantPlatform: 1,
      platform: 1,
      status: 1,
      'payment.method': 1,
      'payment.status': 1,
      'pricing.subtotal': 1,
      'pricing.deliveryFee': 1,
      'pricing.platformFee': 1,
      'pricing.tax': 1,
      'pricing.discount': 1,
      'pricing.total': 1,
      'pricing.couponCode': 1,
      deliveryFleet: 1,
      'items.itemId': 1,
      'items.name': 1,
      'items.quantity': 1,
      deliveryPartnerId: 1,
      'assignmentInfo.zoneId': 1,
      'assignmentInfo.zoneName': 1,
      estimatedDeliveryTime: 1,
      deliveredAt: 1,
      cancellationReason: 1,
      cancelledAt: 1,
      cancelledBy: 1,
      scheduledDelivery: 1,
      adminApproval: 1
    };
    const snapshotOrders = normalizedPlatform ? await readOrderSnapshot(normalizedPlatform) : [];

    // Fetch orders (lean) and do lightweight batched lookups instead of heavy populate chains.
    let orders = [];
    const legacyOrdersCollection = mongoose.connection.db.collection('orders');
    // Always query the legacy 'orders' collection directly since the dedicated platform
    // collections (mofoodsorder, mogroceryorder) are not populated yet. Querying nonexistent
    // or empty collections wastes time and forces an expensive fallback anyway.
    const primaryQueryUsesPlatformIndex = Boolean(normalizedPlatform);
    const primaryQueryHint = primaryQueryUsesPlatformIndex
      ? { restaurantPlatform: 1, createdAt: -1 }
      : { createdAt: -1 };
    const sortOrder = { createdAt: -1 };
    let effectiveQuery = primaryPlatformQuery;
    try {
      orders = await legacyOrdersCollection.find(effectiveQuery, { projection: projectionObject })
        .sort(sortOrder)
        .hint(primaryQueryHint)
        .maxTimeMS(10000)
        .limit(normalizedLimit)
        .skip(skip)
        .toArray();

      if (normalizedPlatform && orders.length === 0) {
        effectiveQuery = fallbackQuery;
        orders = await legacyOrdersCollection.find(effectiveQuery, { projection: projectionObject })
          .sort(sortOrder)
          .maxTimeMS(10000)
          .limit(normalizedLimit)
          .skip(skip)
          .toArray();
      }
    } catch (queryError) {
      console.warn(
        `Orders query failed, trying legacy platform fallback:`,
        queryError?.message || queryError
      );
      try {
        effectiveQuery = fallbackQuery;
        orders = await legacyOrdersCollection.find(effectiveQuery, { projection: projectionObject })
          .sort(sortOrder)
          .maxTimeMS(10000)
          .limit(normalizedLimit)
          .skip(skip)
          .toArray();
      } catch (fallbackError) {
        console.warn('Orders fallback query failed, trying unfiltered recent orders:', fallbackError?.message || fallbackError);
        try {
          effectiveQuery = {};
          orders = await legacyOrdersCollection.find({}, { projection: projectionObject })
            .sort(sortOrder)
            .hint({ createdAt: -1 })
            .maxTimeMS(5000)
            .limit(normalizedLimit)
            .skip(skip)
            .toArray();
        } catch (lastResortError) {
          console.error('Orders final fallback query failed:', lastResortError?.message || lastResortError);
          if (snapshotOrders.length > 0) {
            const snapshotResult = filterSnapshotOrders(snapshotOrders, req.query, normalizedPlatform);
            return successResponse(res, 200, 'Orders retrieved successfully', snapshotResult);
          }
          orders = [];
        }
      }
    }

    const userIds = Array.from(
      new Set(
        orders
          .map((order) => String(order?.userId || '').trim())
          .filter((id) => mongoose.Types.ObjectId.isValid(id))
      )
    ).map((id) => new mongoose.Types.ObjectId(id));

    const deliveryIds = Array.from(
      new Set(
        orders
          .flatMap((order) => {
            const ids = [
              String(order?.deliveryPartnerId || '').trim(),
              String(order?.assignmentInfo?.lastRejectedBy || '').trim(),
              String(order?.assignmentInfo?.deliveryPartnerId || '').trim(),
            ];

            const rejectedIds = Array.isArray(order?.assignmentInfo?.rejectedDeliveryPartnerIds)
              ? order.assignmentInfo.rejectedDeliveryPartnerIds.map((id) => String(id || '').trim())
              : [];

            return [...ids, ...rejectedIds];
          })
          .filter((id) => mongoose.Types.ObjectId.isValid(id))
      )
    ).map((id) => new mongoose.Types.ObjectId(id));
    const restaurantIds = Array.from(
      new Set(
        orders
          .map((order) => String(order?.restaurantId || '').trim())
          .filter((id) => mongoose.Types.ObjectId.isValid(id))
      )
    ).map((id) => new mongoose.Types.ObjectId(id));

    const usersCollection = mongoose.connection.db.collection('users');
    const deliveriesCollection = mongoose.connection.db.collection('deliveries');
    const restaurantsCollection = mongoose.connection.db.collection('restaurants');
    const groceryStoresCollection = mongoose.connection.db.collection('grocerystores');
    const [users, deliveries, restaurants, groceryStores] = await Promise.all([
      userIds.length > 0
        ? usersCollection.find(
            { _id: { $in: userIds } },
            { projection: { _id: 1, name: 1, email: 1, phone: 1 } }
          ).toArray()
        : [],
      deliveryIds.length > 0
        ? deliveriesCollection.find(
            { _id: { $in: deliveryIds } },
            { projection: { _id: 1, name: 1, phone: 1 } }
          ).toArray()
        : [],
      restaurantIds.length > 0
        ? restaurantsCollection.find(
            { _id: { $in: restaurantIds } },
            { projection: { _id: 1, phone: 1, ownerPhone: 1, primaryContactNumber: 1 } }
          ).toArray()
        : [],
      restaurantIds.length > 0
        ? groceryStoresCollection.find(
            { _id: { $in: restaurantIds } },
            { projection: { _id: 1, phone: 1, ownerPhone: 1, primaryContactNumber: 1 } }
          ).toArray()
        : []
    ]);

    const userMap = new Map(users.map((user) => [String(user._id), user]));
    const deliveryMap = new Map(deliveries.map((delivery) => [String(delivery._id), delivery]));
    const restaurantContactMap = new Map();
    [...restaurants, ...groceryStores].forEach((doc) => {
      const contactNumber = doc?.phone || doc?.primaryContactNumber || doc?.ownerPhone || '';
      if (!contactNumber) return;
      restaurantContactMap.set(String(doc._id), contactNumber);
    });

    // Get total count.
    // countDocuments can be very slow on large/unindexed filters; fail fast and fallback
    // so the orders list can render instead of timing out.
    let total = 0;
    try {
      total = await legacyOrdersCollection.countDocuments(effectiveQuery, { maxTimeMS: 8000 });
    } catch (countError) {
      console.warn('Order count timed out, using fallback total:', countError?.message || countError);
      total = skip + (orders?.length || 0);
    }

    // Batch fetch settlements for platform fee and refund status (more efficient than individual queries)
    let settlementMap = new Map();
    let refundStatusMap = new Map();
    try {
      const orderIds = orders.map(o => o._id);
      const settlementsCollection = mongoose.connection.db.collection('ordersettlements');
      const settlements = await settlementsCollection.find(
        { orderId: { $in: orderIds } },
        { projection: { orderId: 1, 'userPayment.platformFee': 1, 'cancellationDetails.refundStatus': 1 } }
      ).toArray();
      
      // Create maps for quick lookup
      settlements.forEach(s => {
        if (s.orderId) {
          if (s.userPayment?.platformFee !== undefined) {
            settlementMap.set(s.orderId.toString(), s.userPayment.platformFee);
          }
          if (s.cancellationDetails?.refundStatus) {
            refundStatusMap.set(s.orderId.toString(), s.cancellationDetails.refundStatus);
          }
        }
      });
    } catch (err) {
      console.warn('Could not batch fetch settlements:', err.message);
    }

    // Transform orders to match frontend format
    const transformedOrders = orders.reduce((acc, order, index) => {
      try {
      const orderDate = new Date(order.createdAt);
      const dateStr = orderDate.toLocaleDateString('en-GB', { 
        day: '2-digit', 
        month: 'short', 
        year: 'numeric' 
      }).toUpperCase();
      const timeStr = orderDate.toLocaleTimeString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: true 
      }).toUpperCase();

      // Get customer phone (unmasked - show full number for admin)
      const user = userMap.get(String(order.userId || '')) || null;
      const delivery = deliveryMap.get(String(order.deliveryPartnerId || '')) || null;
      const assignmentDelivery =
        deliveryMap.get(String(order.assignmentInfo?.deliveryPartnerId || '')) || null;
      const lastRejectedDelivery =
        deliveryMap.get(String(order.assignmentInfo?.lastRejectedBy || '')) || null;
      const customerPhone = user?.phone || '';
      const restaurantPhone = restaurantContactMap.get(String(order.restaurantId || '')) || '';
      const riderAccepted = hasAcceptedRider(order);

      // Map payment status
      const paymentMethod = String(order.payment?.method || '').toLowerCase();
      const isCodPayment = paymentMethod === 'cash' || paymentMethod === 'cod';
      const paymentStatusMap = {
        'completed': 'Paid',
        'pending': 'Pending',
        'failed': 'Failed',
        'refunded': 'Refunded',
        'processing': 'Processing'
      };
      // COD/cash orders are considered paid only after delivery is completed.
      const paymentStatusDisplay = isCodPayment
        ? (order.status === 'delivered' ? 'Paid' : 'Pending')
        : (paymentStatusMap[order.payment?.status] || 'Pending');

      // Map order status for display
      // Check if cancelled and determine who cancelled it
      let orderStatusDisplay;
      if (order.status === 'cancelled') {
        const timedOutByRestaurant = isRestaurantAcceptTimeoutOrder(order);
        // Check cancelledBy field to determine who cancelled
        if (timedOutByRestaurant) {
          orderStatusDisplay = 'Not Accepted in Time';
        } else if (order.cancelledBy === 'restaurant') {
          orderStatusDisplay = 'Cancelled by Restaurant';
        } else if (order.cancelledBy === 'user') {
          orderStatusDisplay = 'Cancelled by User';
        } else {
          // Fallback: check cancellation reason pattern for old orders
          const cancellationReason = order.cancellationReason || '';
          const isRestaurantCancelled = /rejected by restaurant|restaurant rejected|restaurant cancelled|restaurant is too busy|item not available|outside delivery area|kitchen closing|technical issue/i.test(cancellationReason);
          orderStatusDisplay = isRestaurantCancelled ? 'Cancelled by Restaurant' : 'Cancelled by User';
        }
      } else {
        const statusMap = {
          'pending': 'Pending',
          'confirmed': 'Pending',
          'preparing': 'Processing',
          'ready': 'Ready',
          'out_for_delivery': 'Food On The Way',
          'delivered': 'Delivered',
          'scheduled': 'Scheduled',
          'dine_in': 'Dine In'
        };
        orderStatusDisplay = statusMap[order.status] || order.status;
      }

      // Determine delivery type
      const deliveryType = order.deliveryFleet === 'standard' ? 
        'Home Delivery' : 
        (order.deliveryFleet === 'fast' ? 'Fast Delivery' : 'Home Delivery');

      // Calculate report-specific fields
      const subtotal = order.pricing?.subtotal || 0;
      const discount = order.pricing?.discount || 0;
      const deliveryFee = order.pricing?.deliveryFee || 0;
      const tax = order.pricing?.tax || 0;
      const couponCode = order.pricing?.couponCode || null;
      
      // Get platform fee - check if it exists in pricing, otherwise get from settlement map
      let platformFee = order.pricing?.platformFee;
      if (platformFee === undefined || platformFee === null) {
        // Get from settlement map (batch fetched above)
        platformFee = settlementMap.get(order._id.toString());
        
        // If still not found, calculate from total (fallback for old orders)
        if (platformFee === undefined || platformFee === null) {
          const calculatedTotal = (order.pricing?.subtotal || 0) - (order.pricing?.discount || 0) + (order.pricing?.deliveryFee || 0) + (order.pricing?.tax || 0);
          const actualTotal = order.pricing?.total || 0;
          const difference = actualTotal - calculatedTotal;
          // If difference is positive and reasonable (between 0 and 50), assume it's platform fee
          platformFee = (difference > 0 && difference <= 50) ? difference : 0;
        }
      }
      
      // For report: itemDiscount is the discount applied to items
      const itemDiscount = discount;
      // Discounted amount is subtotal after discount
      const discountedAmount = Math.max(0, subtotal - discount);
      // Coupon discount (if coupon was applied, it's part of discount)
      const couponDiscount = couponCode ? discount : 0;
      // Referral discount (not currently in model, default to 0)
      const referralDiscount = 0;
      // VAT/Tax
      const vatTax = tax;
      // Delivery charge
      const deliveryCharge = deliveryFee;
      // Total item amount (subtotal before discounts)
      const totalItemAmount = subtotal;
      // Order amount (final total)
      const orderAmount = order.pricing?.total || 0;
      const scheduledFor = order?.scheduledDelivery?.scheduledFor ? new Date(order.scheduledDelivery.scheduledFor) : null;
      const isScheduled = Boolean(order?.scheduledDelivery?.isScheduled && scheduledFor);
      const scheduledDate = isScheduled
        ? scheduledFor.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase()
        : '';
      const scheduledTime = isScheduled
        ? scheduledFor.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }).toUpperCase()
        : '';

      const derivedRestaurantPlatform = String(
        normalizedPlatform ||
        order.restaurantId?.platform ||
        order.restaurantPlatform ||
        'mofood'
      ).toLowerCase();
      const timedOutByRestaurant = isRestaurantAcceptTimeoutOrder(order);
      const acceptanceTimeoutAt = timedOutByRestaurant
        ? new Date(new Date(order.createdAt).getTime() + RESTAURANT_ACCEPT_TIMEOUT_MS)
        : null;

      acc.push({
        sl: skip + index + 1,
        orderId: order.orderId,
        id: order._id.toString(),
        date: dateStr,
        time: timeStr,
        customerName: user?.name || 'Unknown',
        customerPhone: customerPhone,
        customerEmail: user?.email || '',
        restaurant: order.restaurantName || order.restaurantId?.name || 'Unknown Restaurant',
        restaurantId: order.restaurantId?.toString() || order.restaurantId || '',
        restaurantPhone,
        restaurantPlatform: derivedRestaurantPlatform,
        // Report-specific fields
        totalItemAmount: totalItemAmount,
        itemDiscount: itemDiscount,
        discountedAmount: discountedAmount,
        couponDiscount: couponDiscount,
        referralDiscount: referralDiscount,
        vatTax: vatTax,
        deliveryCharge: deliveryCharge,
        platformFee: platformFee,
        totalAmount: orderAmount,
        // Original fields
        paymentStatus: paymentStatusDisplay,
        paymentType: (() => {
          const paymentMethod = order.payment?.method;
          if (paymentMethod === 'cash' || paymentMethod === 'cod') {
            return 'Cash on Delivery';
          } else if (paymentMethod === 'wallet') {
            return 'Wallet';
          } else {
            return 'Online';
          }
        })(),
        paymentCollectionStatus: (order.payment?.method === 'cash' || order.payment?.method === 'cod')
          ? (order.status === 'delivered' ? 'Collected' : 'Not Collected')
          : (String(order.payment?.status || '').toLowerCase() === 'completed' ? 'Collected' : 'Not Collected'),
        orderStatus: orderStatusDisplay,
        status: order.status, // Backend status
        adminApprovalStatus: order.adminApproval?.status || null,
        // MoGrocery now follows direct store acceptance flow (no admin pre-approval gate).
        canAdminApprove: false,
        adminApprovalReason: order.adminApproval?.reason || null,
        adminReviewedAt: order.adminApproval?.reviewedAt || null,
        deliveryType: deliveryType,
        items: order.items || [],
        rejectedItems: order.rejectedItems || [],
        address: order.address || {},
        deliveryPartnerId: delivery?._id?.toString?.() || (order.deliveryPartnerId ? String(order.deliveryPartnerId) : null),
        deliveryPartnerName: delivery?.name || null,
        deliveryPartnerPhone: delivery?.phone || null,
        assignmentInfo: {
          assignedBy: order.assignmentInfo?.assignedBy || null,
          assignedAt: order.assignmentInfo?.assignedAt || null,
          notificationPhase: order.assignmentInfo?.notificationPhase || null,
          deliveryPartnerId: order.assignmentInfo?.deliveryPartnerId || null,
          acceptedFromNotification: Boolean(order.assignmentInfo?.acceptedFromNotification),
          acceptedByName: riderAccepted ? (delivery?.name || assignmentDelivery?.name || null) : null,
          acceptedByPhone: riderAccepted ? (delivery?.phone || assignmentDelivery?.phone || null) : null,
          lastRejectedBy: order.assignmentInfo?.lastRejectedBy || null,
          lastRejectedByName: lastRejectedDelivery?.name || null,
          lastRejectedByPhone: lastRejectedDelivery?.phone || null,
          lastRejectedAt: order.assignmentInfo?.lastRejectedAt || null,
          lastRejectionReason: order.assignmentInfo?.lastRejectionReason || null,
          rejectedDeliveryPartnerIds: Array.isArray(order.assignmentInfo?.rejectedDeliveryPartnerIds)
            ? order.assignmentInfo.rejectedDeliveryPartnerIds
            : [],
        },
        estimatedDeliveryTime: order.estimatedDeliveryTime || 30,
        deliveredAt: order.deliveredAt,
        cancellationReason: order.cancellationReason || null,
        cancelledAt: order.cancelledAt || null,
        cancelledBy: order.cancelledBy || null,
        timedOutByRestaurant,
        acceptanceTimeoutAt,
        tracking: order.tracking || {},
        deliveryState: order.deliveryState || {},
        billImageUrl: order.billImageUrl || null, // Bill image captured by delivery boy
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        // Zone info from assignmentInfo
        zoneId: order.assignmentInfo?.zoneId || null,
        zoneName:
          order.assignmentInfo?.zoneName ||
          order.zoneName ||
          order.zone ||
          null,
        // Refund status from settlement
        refundStatus: refundStatusMap.get(order._id.toString()) || null,
        // 2-minute edit/cancel window for customer (MoFood and MoGrocery)
        modificationWindow: getOrderModificationWindow(order),
        postOrderActions: order.postOrderActions || null,
        scheduledDelivery: order.scheduledDelivery || null,
        isScheduled,
        scheduledFor: scheduledFor || null,
        scheduledDate,
        scheduledTime,
        scheduledTimeSlot: order?.scheduledDelivery?.timeSlot || ''
      });
      } catch (transformError) {
        console.warn(
          `Skipping malformed order during admin transform (id: ${order?._id || 'unknown'}):`,
          transformError?.message || transformError
        );
      }
      return acc;
    }, []);

    return successResponse(res, 200, 'Orders retrieved successfully', {
      orders: transformedOrders,
      pagination: {
        page: normalizedPage,
        limit: normalizedLimit,
        total,
        pages: Math.ceil(total / normalizedLimit)
      }
    });
  } catch (error) {
    console.error('Error fetching admin orders:', error);
    return errorResponse(res, 500, 'Failed to fetch orders');
  }
});

/**
 * DELETE /api/admin/orders/:id
 * Permanently remove an order and linked records.
 */
export const deleteOrderPermanently = asyncHandler(async (req, res) => {
  try {
    if (!canAdminDeleteOrders(req.user)) {
      return errorResponse(res, 403, 'Only super admins can permanently delete orders');
    }

    const orderIdentifier = String(req.params.id || '').trim();
    if (!orderIdentifier) {
      return errorResponse(res, 400, 'Order ID is required');
    }

    // No transaction: after the reconnect logic in config/db.js runs,
    // mongoose.startSession() can return a session from a different MongoClient
    // than the models use, which made every delete fail. Each step below is
    // safe to repeat and the order itself is removed last, so a delete that
    // fails part-way can simply be retried.
    const order = await findOrderByAdminIdentifier(orderIdentifier);

    if (!order) {
      return errorResponse(res, 404, 'Order not found');
    }
    if (!canAdminAccessOrder(req.user, order)) {
      return errorResponse(res, 403, 'Access denied for orders outside your assigned zones');
    }

    const isGroceryOrder =
      String(order.restaurantPlatform || order.platform || '').toLowerCase() === 'mogrocery';
    const groceryStockWasReduced = Boolean(order.stockSync?.grocery?.reduced);
    const groceryStockAlreadyRestored = Boolean(order.stockSync?.grocery?.restored);

    if (
      isGroceryOrder &&
      groceryStockWasReduced &&
      !groceryStockAlreadyRestored &&
      order.status !== 'delivered'
    ) {
      await restoreGroceryStockForOrder(order);
    }

    const orderId = order._id;

    await Promise.all([
      Payment.deleteMany({ orderId }),
      OrderSettlement.deleteMany({ orderId }),
      OrderEvent.deleteMany({ orderId }),
      ETALog.deleteMany({ orderId }),
      AuditLog.deleteMany({ orderId }),
    ]);

    await Order.deleteOne({ _id: orderId });

    return successResponse(res, 200, 'Order deleted permanently', {
      orderId: order.orderId,
      id: order._id,
    });
  } catch (error) {
    console.error('Error deleting order permanently:', error);
    return errorResponse(res, 500, 'Failed to delete order');
  }
});

/**
 * Get order by ID for admin
 * GET /api/admin/orders/:id
 */
export const getOrderById = asyncHandler(async (req, res) => {
  try {
    const { id } = req.params;

    let order = null;
    
    // Try MongoDB _id first
    if (mongoose.Types.ObjectId.isValid(id) && id.length === 24) {
      order = await Order.findById(id)
        .populate('userId', 'name email phone')
        .populate('restaurantId', 'name slug location address phone')
        .populate('deliveryPartnerId', 'name phone availability')
        .lean();
    }
    
    // If not found, try by orderId
    if (!order) {
      order = await Order.findOne({ orderId: id })
        .populate('userId', 'name email phone')
        .populate('restaurantId', 'name slug location address phone')
        .populate('deliveryPartnerId', 'name phone availability')
        .lean();
    }

    if (!order) {
      return errorResponse(res, 404, 'Order not found');
    }
    if (!canAdminAccessOrder(req.user, order)) {
      return errorResponse(res, 403, 'Access denied for orders outside your assigned zones');
    }

    const timedOutByRestaurant = isRestaurantAcceptTimeoutOrder(order);
    const acceptanceTimeoutAt = timedOutByRestaurant
      ? new Date(new Date(order.createdAt).getTime() + RESTAURANT_ACCEPT_TIMEOUT_MS)
      : null;

    const orderDate = new Date(order.createdAt);
    const user = order.userId || {};
    const delivery = order.deliveryPartnerId || {};
    let restaurantPhone =
      order.restaurantId?.phone ||
      order.restaurantId?.primaryContactNumber ||
      order.restaurantId?.ownerPhone ||
      '';

    if (!restaurantPhone) {
      const Restaurant = (await import('../../restaurant/models/Restaurant.js')).default;
      const GroceryStore = (await import('../../grocery/models/GroceryStore.js')).default;
      const restaurantId = String(order.restaurantId?._id || order.restaurantId || '').trim();

      if (restaurantId) {
        let restaurantDoc = null;
        if (mongoose.Types.ObjectId.isValid(restaurantId) && restaurantId.length === 24) {
          restaurantDoc =
            await Restaurant.findById(restaurantId).select('phone ownerPhone primaryContactNumber').lean() ||
            await GroceryStore.findById(restaurantId).select('phone ownerPhone primaryContactNumber').lean();
        }

        restaurantPhone =
          restaurantDoc?.phone ||
          restaurantDoc?.primaryContactNumber ||
          restaurantDoc?.ownerPhone ||
          '';
      }
    }

    const paymentMethod = String(order.payment?.method || '').toLowerCase();
    const isCodPayment = paymentMethod === 'cash' || paymentMethod === 'cod';
    const paymentStatusMap = {
      completed: 'Paid',
      pending: 'Pending',
      failed: 'Failed',
      refunded: 'Refunded',
      processing: 'Processing'
    };
    const paymentStatusDisplay = isCodPayment
      ? (order.status === 'delivered' ? 'Paid' : 'Pending')
      : (paymentStatusMap[order.payment?.status] || 'Pending');
    const displayStatusMap = {
      pending: 'Pending',
      confirmed: 'Pending',
      preparing: 'Processing',
      ready: 'Ready',
      out_for_delivery: 'Food On The Way',
      delivered: 'Delivered',
      scheduled: 'Scheduled',
      dine_in: 'Dine In'
    };
    let orderStatusDisplay = displayStatusMap[order.status] || order.status;
    if (order.status === 'cancelled') {
      if (timedOutByRestaurant) {
        orderStatusDisplay = 'Not Accepted in Time';
      } else if (order.cancelledBy === 'restaurant') {
        orderStatusDisplay = 'Cancelled by Restaurant';
      } else if (order.cancelledBy === 'user') {
        orderStatusDisplay = 'Cancelled by User';
      } else {
        orderStatusDisplay = 'Canceled';
      }
    }

    return successResponse(res, 200, 'Order retrieved successfully', {
      order: {
        ...order,
        id: order._id?.toString?.() || String(order._id || ''),
        date: orderDate.toLocaleDateString('en-GB', {
          day: '2-digit',
          month: 'short',
          year: 'numeric'
        }).toUpperCase(),
        time: orderDate.toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: true
        }).toUpperCase(),
        customerName: user?.name || 'Unknown',
        customerPhone: user?.phone || '',
        customerEmail: user?.email || '',
        restaurant: order.restaurantName || order.restaurantId?.name || 'Unknown Restaurant',
        restaurantPhone,
        paymentStatus: paymentStatusDisplay,
        paymentType: isCodPayment ? 'Cash on Delivery' : (paymentMethod === 'wallet' ? 'Wallet' : 'Online'),
        paymentCollectionStatus: isCodPayment
          ? (order.status === 'delivered' ? 'Collected' : 'Not Collected')
          : (String(order.payment?.status || '').toLowerCase() === 'completed' ? 'Collected' : 'Not Collected'),
        orderStatus: orderStatusDisplay,
        deliveryType: order.deliveryFleet === 'fast' ? 'Fast Delivery' : 'Home Delivery',
        totalItemAmount: order.pricing?.subtotal || 0,
        itemDiscount: order.pricing?.discount || 0,
        couponDiscount: order.pricing?.couponCode ? (order.pricing?.discount || 0) : 0,
        deliveryCharge: order.pricing?.deliveryFee || 0,
        platformFee: order.pricing?.platformFee || 0,
        vatTax: order.pricing?.tax || 0,
        totalAmount: order.pricing?.total || 0,
        deliveryPartnerName: delivery?.name || null,
        deliveryPartnerPhone: delivery?.phone || null,
        rejectedItems: order.rejectedItems || [],
        timedOutByRestaurant,
        acceptanceTimeoutAt
      }
    });
  } catch (error) {
    console.error('Error fetching order:', error);
    return errorResponse(res, 500, 'Failed to fetch order');
  }
});

const resolveAdminOrderById = async (id) => {
  if (mongoose.Types.ObjectId.isValid(id) && id.length === 24) {
    const byMongoId = await Order.findById(id);
    if (byMongoId) return byMongoId;
  }
  return Order.findOne({ orderId: id });
};

const normalizeRejectedItemsPayload = (items = []) =>
  (Array.isArray(items) ? items : [])
    .map((item) => ({
      itemRef: String(item?.itemRef || item?.itemId || item?._id || '').trim(),
      reason: String(item?.reason || '').trim(),
      quantity: Number(item?.quantity || 0)
    }))
    .filter((item) => item.itemRef && item.reason && Number.isFinite(item.quantity) && item.quantity > 0);

const calculateAdjustedOrderTotals = (order, items) => {
  const subtotal = items.reduce(
    (sum, item) => sum + (Number(item?.price || 0) * Number(item?.quantity || 0)),
    0
  );
  const deliveryFee = Number(order?.pricing?.deliveryFee || 0);
  const platformFee = Number(order?.pricing?.platformFee || 0);
  const tax = Number(order?.pricing?.tax || 0);
  const discount = Number(order?.pricing?.discount || 0);
  const total = Math.max(0, subtotal + deliveryFee + platformFee + tax - discount);

  return {
    subtotal: Number(subtotal.toFixed(2)),
    total: Number(total.toFixed(2))
  };
};

const applyPartialItemRejectionToOrder = (order, rejectedItemsPayload, adminId = null) => {
  const normalizedRejectedItems = normalizeRejectedItemsPayload(rejectedItemsPayload);
  if (!normalizedRejectedItems.length) {
    return {
      applied: false,
      rejectedItems: [],
      pricingAdjustment: null
    };
  }

  const currentItems = Array.isArray(order?.items) ? order.items : [];
  const selectedItemMap = new Map(
    normalizedRejectedItems.map((item) => [item.itemRef, item])
  );

  const remainingItems = [];
  const rejectedItems = [];

  for (const item of currentItems) {
    const itemObjectId = String(item?._id || '').trim();
    const itemBusinessId = String(item?.itemId || '').trim();
    const matchedSelection = selectedItemMap.get(itemObjectId) || selectedItemMap.get(itemBusinessId);

    if (!matchedSelection) {
      remainingItems.push(item);
      continue;
    }

    const currentQuantity = Math.max(1, Number(item?.quantity || 1));
    const requestedRejectedQuantity = Math.max(0, Number(matchedSelection.quantity || 0));

    if (requestedRejectedQuantity > currentQuantity) {
      throw new Error(`Rejected quantity for "${item?.name || 'item'}" exceeds the ordered quantity`);
    }

    const remainingQuantity = currentQuantity - requestedRejectedQuantity;
    const nextItem = item?.toObject ? item.toObject() : { ...item };

    if (remainingQuantity > 0) {
      remainingItems.push({
        ...nextItem,
        quantity: remainingQuantity
      });
    }

    rejectedItems.push({
      itemId: item.itemId,
      name: item.name,
      price: Number(item.price || 0),
      quantity: requestedRejectedQuantity,
      image: item.image || '',
      description: item.description || '',
      isVeg: item.isVeg !== false,
      rejectionReason: matchedSelection.reason,
      rejectedAt: new Date(),
      rejectedBySource: 'admin',
      rejectedByAdmin: adminId || null
    });
  }

  if (!rejectedItems.length) {
    throw new Error('No matching order items were found for rejection');
  }

  if (!remainingItems.length) {
    throw new Error('Cannot reject every item with partial acceptance. Please use full order rejection instead.');
  }

  const previousSubtotal = Number(order?.pricing?.subtotal || 0);
  const previousTotal = Number(order?.pricing?.total || 0);
  const nextTotals = calculateAdjustedOrderTotals(order, remainingItems);

  order.items = remainingItems;
  order.rejectedItems = [...(Array.isArray(order?.rejectedItems) ? order.rejectedItems : []), ...rejectedItems];
  order.pricing.subtotal = nextTotals.subtotal;
  order.pricing.total = nextTotals.total;

  return {
    applied: true,
    rejectedItems,
    pricingAdjustment: {
      previousSubtotal,
      nextSubtotal: nextTotals.subtotal,
      previousTotal,
      nextTotal: nextTotals.total,
      reductionAmount: Number(Math.max(0, previousTotal - nextTotals.total).toFixed(2))
    }
  };
};

const resolveRestaurantForOrder = async (order) => {
  if (!order?.restaurantId) return null;

  const Restaurant = (await import('../../restaurant/models/Restaurant.js')).default;
  const restaurantId = String(order.restaurantId);

  if (mongoose.Types.ObjectId.isValid(restaurantId) && restaurantId.length === 24) {
    const byId = await Restaurant.findById(restaurantId).lean();
    if (byId) return byId;
  }

  return Restaurant.findOne({
    $or: [
      { restaurantId },
      { slug: restaurantId }
    ]
  }).lean();
};

const resolveStoreDocumentForOrder = async (order) => {
  if (!order?.restaurantId) return null;

  const restaurantId = String(order.restaurantId).trim();
  if (!restaurantId) return null;

  const Restaurant = (await import('../../restaurant/models/Restaurant.js')).default;
  const GroceryStore = (await import('../../grocery/models/GroceryStore.js')).default;

  if (mongoose.Types.ObjectId.isValid(restaurantId) && restaurantId.length === 24) {
    const restaurantById = await Restaurant.findById(restaurantId);
    if (restaurantById) return restaurantById;

    const groceryById = await GroceryStore.findById(restaurantId);
    if (groceryById) return groceryById;
  }

  const restaurantByAlias = await Restaurant.findOne({
    $or: [
      { restaurantId },
      { slug: restaurantId }
    ]
  });
  if (restaurantByAlias) return restaurantByAlias;

  return GroceryStore.findOne({
    $or: [
      { restaurantId },
      { slug: restaurantId }
    ]
  });
};

const isOrderAdminApprovalAllowed = (restaurantDoc) =>
  String(restaurantDoc?.platform || 'mofood').toLowerCase() === 'mogrocery';

const triggerDeliveryBroadcastForApprovedOrder = async (order, restaurantDoc) => {
  try {
    if (!order || order.status === 'cancelled' || order.deliveryPartnerId) return;

    const coords = restaurantDoc?.location?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return;

    const [restaurantLng, restaurantLat] = coords;
    if ((restaurantLng === 0 && restaurantLat === 0) || !restaurantLng || !restaurantLat) return;

    const freshOrder = await Order.findById(order._id);
    if (!freshOrder || freshOrder.deliveryPartnerId || freshOrder.status === 'cancelled') return;

    const { findNearestDeliveryBoys, findNearestDeliveryBoy } =
      await import('../../order/services/deliveryAssignmentService.js');
    const { notifyMultipleDeliveryBoys } =
      await import('../../order/services/deliveryNotificationService.js');

    const restaurantLookupId = restaurantDoc?._id?.toString() || String(order.restaurantId);
    const requiredZoneId = freshOrder?.assignmentInfo?.zoneId ? String(freshOrder.assignmentInfo.zoneId) : null;
    const priorityDeliveryBoys = await findNearestDeliveryBoys(
      restaurantLat,
      restaurantLng,
      restaurantLookupId,
      5,
      { requiredZoneId }
    );

    if (priorityDeliveryBoys && priorityDeliveryBoys.length > 0) {
      const priorityIds = priorityDeliveryBoys.map((db) => db.deliveryPartnerId);
      freshOrder.assignmentInfo = {
        ...(freshOrder.assignmentInfo || {}),
        priorityNotifiedAt: new Date(),
        priorityDeliveryPartnerIds: priorityIds,
        notificationPhase: 'priority'
      };
      await freshOrder.save();

      const populatedOrder = await Order.findById(freshOrder._id)
        .populate('userId', 'name phone')
        .lean();

      if (populatedOrder) {
        await notifyMultipleDeliveryBoys(populatedOrder, priorityIds, 'priority');
      }

      setTimeout(async () => {
        try {
          const checkOrder = await Order.findById(order._id);
          if (!checkOrder || checkOrder.deliveryPartnerId || checkOrder.status === 'cancelled') return;

          const allDeliveryBoys = await findNearestDeliveryBoys(
            restaurantLat,
            restaurantLng,
            restaurantLookupId,
            50,
            { requiredZoneId }
          );
          const expandedDeliveryBoys = allDeliveryBoys.filter(
            (db) => !priorityIds.includes(db.deliveryPartnerId)
          );

          if (expandedDeliveryBoys.length === 0) return;

          const expandedIds = expandedDeliveryBoys.map((db) => db.deliveryPartnerId);
          checkOrder.assignmentInfo = {
            ...(checkOrder.assignmentInfo || {}),
            expandedNotifiedAt: new Date(),
            expandedDeliveryPartnerIds: expandedIds,
            notificationPhase: 'expanded'
          };
          await checkOrder.save();

          const expandedOrder = await Order.findById(checkOrder._id)
            .populate('userId', 'name phone')
            .lean();

          if (expandedOrder) {
            await notifyMultipleDeliveryBoys(expandedOrder, expandedIds, 'expanded');
          }
        } catch (expandedErr) {
          console.error(`Expanded delivery broadcast failed for ${order.orderId}:`, expandedErr);
        }
      }, 30000);
      return;
    }

    const anyDeliveryBoy = await findNearestDeliveryBoy(
      restaurantLat,
      restaurantLng,
      restaurantLookupId,
      50,
      [],
      { requiredZoneId }
    );
    if (!anyDeliveryBoy) return;

    freshOrder.assignmentInfo = {
      ...(freshOrder.assignmentInfo || {}),
      priorityNotifiedAt: new Date(),
      priorityDeliveryPartnerIds: [anyDeliveryBoy.deliveryPartnerId],
      notificationPhase: 'immediate'
    };
    await freshOrder.save();

    const populatedOrder = await Order.findById(freshOrder._id)
      .populate('userId', 'name phone')
      .lean();

    if (populatedOrder) {
      await notifyMultipleDeliveryBoys(populatedOrder, [anyDeliveryBoy.deliveryPartnerId], 'immediate');
    }
  } catch (error) {
    console.error(`Failed to trigger delivery broadcast for approved order ${order?.orderId}:`, error);
  }
};

/**
 * Approve incoming user order request
 * POST /api/admin/orders/:id/approve
 */
export const approveOrderRequest = asyncHandler(async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user?._id || req.admin?._id;

    const order = await resolveAdminOrderById(id);
    if (!order) {
      return errorResponse(res, 404, 'Order not found');
    }

    if (order.status === 'cancelled') {
      return errorResponse(res, 400, 'Cannot approve a cancelled order');
    }

    if (order.adminApproval?.status === 'approved') {
      return errorResponse(res, 400, 'Order is already approved');
    }

    const { notifyRestaurantOrderUpdate } =
      await import('../../order/services/restaurantNotificationService.js');
    const restaurantDoc = await resolveRestaurantForOrder(order);

    if (!isOrderAdminApprovalAllowed(restaurantDoc)) {
      return errorResponse(res, 400, 'MoFood orders must be accepted/rejected by restaurant only');
    }

    order.adminApproval = {
      status: 'approved',
      reason: '',
      reviewedAt: new Date(),
      reviewedBy: adminId || null
    };
    order.acceptanceInfo = {
      source: 'admin',
      acceptedAt: new Date(),
      acceptedByAdmin: adminId || null
    };

    order.status = 'preparing';
    if (!order.tracking?.confirmed?.status) {
      order.tracking.confirmed = { status: true, timestamp: new Date() };
    }
    order.tracking.preparing = { status: true, timestamp: new Date() };
    await order.save();

    try {
      await notifyRestaurantOrderUpdate(order._id.toString(), 'preparing');
    } catch (notifError) {
      console.error(`Failed to emit preparing update for approved order ${order.orderId}:`, notifError);
    }

    return successResponse(res, 200, 'Order approved successfully', {
      orderId: order.orderId,
      orderMongoId: order._id,
      approvalStatus: order.adminApproval.status,
      approvedAt: order.adminApproval.reviewedAt,
      orderStatus: order.status
    });
  } catch (error) {
    console.error('Error approving order request:', error);
    return errorResponse(res, 500, 'Failed to approve order');
  }
});

/**
 * Accept order directly from admin using the same store/restaurant flow.
 * PATCH /api/admin/orders/:id/accept
 */
export const acceptOrderFromAdmin = asyncHandler(async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user?._id || req.admin?._id;
    const rejectedItemsPayload = normalizeRejectedItemsPayload(req.body?.rejectedItems);

    const order = await resolveAdminOrderById(id);
    if (!order) {
      return errorResponse(res, 404, 'Order not found');
    }
    if (!canAdminAccessOrder(req.user, order)) {
      return errorResponse(res, 403, 'Access denied for orders outside your assigned zones');
    }

    if (order.status === 'cancelled') {
      return errorResponse(res, 400, 'Cannot accept a cancelled order');
    }

    if (order.status === 'delivered') {
      return errorResponse(res, 400, 'Cannot accept a delivered order');
    }

    if (rejectedItemsPayload.length > 0) {
      if (!['pending', 'confirmed'].includes(String(order.status || '').toLowerCase())) {
        return errorResponse(res, 400, 'Single-item rejection is only available before the order is accepted');
      }

      try {
        applyPartialItemRejectionToOrder(order, rejectedItemsPayload, adminId || null);
        await order.save();
      } catch (partialRejectError) {
        return errorResponse(res, 400, partialRejectError.message || 'Failed to reject selected items');
      }
    }

    const storeDocument = await resolveStoreDocumentForOrder(order);
    if (!storeDocument) {
      return errorResponse(res, 404, 'Restaurant or store not found for this order');
    }

    const { acceptOrder: restaurantAcceptOrder } =
      await import('../../restaurant/controllers/restaurantOrderController.js');

    req.params.id = order._id.toString();
    req.restaurant = storeDocument;
    req.acceptanceActor = {
      source: 'admin',
      adminId: adminId || null
    };
    req.body = {
      ...(req.body || {}),
      rejectedItems: rejectedItemsPayload,
      skipDeliveryAssignment: true,
      deliveryNotificationStrategy: 'all_zone'
    };

    return restaurantAcceptOrder(req, res);
  } catch (error) {
    console.error('Error accepting order from admin:', error);
    return errorResponse(res, 500, 'Failed to accept order');
  }
});

/**
 * Reject order directly from admin using the same store/restaurant flow.
 * PATCH /api/admin/orders/:id/reject-direct
 */
export const rejectOrderFromAdmin = asyncHandler(async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason || !String(reason).trim()) {
      return errorResponse(res, 400, 'Rejection reason is required');
    }

    const order = await resolveAdminOrderById(id);
    if (!order) {
      return errorResponse(res, 404, 'Order not found');
    }
    if (!canAdminAccessOrder(req.user, order)) {
      return errorResponse(res, 403, 'Access denied for orders outside your assigned zones');
    }

    if (order.status === 'cancelled') {
      return errorResponse(res, 400, 'Order is already cancelled');
    }

    if (order.status === 'delivered') {
      return errorResponse(res, 400, 'Cannot reject a delivered order');
    }

    const storeDocument = await resolveStoreDocumentForOrder(order);
    if (!storeDocument) {
      return errorResponse(res, 404, 'Restaurant or store not found for this order');
    }

    const { rejectOrder: restaurantRejectOrder } =
      await import('../../restaurant/controllers/restaurantOrderController.js');

    req.params.id = order._id.toString();
    req.body = {
      ...req.body,
      reason: String(reason).trim()
    };
    req.restaurant = storeDocument;

    return restaurantRejectOrder(req, res);
  } catch (error) {
    console.error('Error rejecting order from admin:', error);
    return errorResponse(res, 500, 'Failed to reject order');
  }
});

/**
 * Reject incoming user order request
 * POST /api/admin/orders/:id/reject
 */
export const rejectOrderRequest = asyncHandler(async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const adminId = req.user?._id || req.admin?._id;

    if (!reason || !reason.trim()) {
      return errorResponse(res, 400, 'Rejection reason is required');
    }

    const order = await resolveAdminOrderById(id);
    if (!order) {
      return errorResponse(res, 404, 'Order not found');
    }
    if (!canAdminAccessOrder(req.user, order)) {
      return errorResponse(res, 403, 'Access denied for orders outside your assigned zones');
    }

    if (order.adminApproval?.status === 'rejected' || order.status === 'cancelled') {
      return errorResponse(res, 400, 'Order is already rejected/cancelled');
    }

    if (order.status === 'delivered') {
      return errorResponse(res, 400, 'Cannot reject/cancel a delivered order');
    }

    const restaurantDoc = await resolveRestaurantForOrder(order);
    if (!isOrderAdminApprovalAllowed(restaurantDoc)) {
      return errorResponse(res, 400, 'MoFood orders must be accepted/rejected by restaurant only');
    }

    order.adminApproval = {
      status: 'rejected',
      reason: reason.trim(),
      reviewedAt: new Date(),
      reviewedBy: adminId || null
    };

    order.status = 'cancelled';
    order.cancelledBy = 'admin';
    order.cancellationReason = reason.trim();
    order.cancelledAt = new Date();
    await order.save();
    await restoreGroceryStockForOrder(order);

    if (order.payment?.method === 'razorpay' || order.payment?.method === 'wallet') {
      try {
        const { calculateCancellationRefund } = await import('../../order/services/cancellationRefundService.js');
        await calculateCancellationRefund(order._id, reason.trim());
      } catch (refundError) {
        console.error(`Failed refund calculation after admin rejection for ${order.orderId}:`, refundError);
      }
    }

    return successResponse(res, 200, 'Order rejected successfully', {
      orderId: order.orderId,
      orderMongoId: order._id,
      approvalStatus: order.adminApproval.status,
      rejectedAt: order.adminApproval.reviewedAt,
      rejectionReason: order.adminApproval.reason,
      orderStatus: order.status
    });
  } catch (error) {
    console.error('Error rejecting order request:', error);
    return errorResponse(res, 500, 'Failed to reject order');
  }
});

/**
 * Resend rider notification for a specific order
 * POST /api/admin/orders/:id/resend-rider-notification
 */
export const resendRiderNotification = asyncHandler(async (req, res) => {
  try {
    const { id } = req.params;

    const order = await resolveAdminOrderById(id);
    if (!order) {
      return errorResponse(res, 404, 'Order not found');
    }
    if (!canAdminAccessOrder(req.user, order)) {
      return errorResponse(res, 403, 'Access denied for orders outside your assigned zones');
    }

    const restaurantDoc = await resolveRestaurantForOrder(order);
    if (!isOrderAdminApprovalAllowed(restaurantDoc)) {
      return errorResponse(res, 400, 'Manual rider assignment is enabled only for MoGrocery orders');
    }

    return errorResponse(
      res,
      400,
      'Automatic rider notifications are disabled. Please assign a delivery boy manually from admin.'
    );
  } catch (error) {
    console.error('Error resending rider notification:', error);
    return errorResponse(res, 500, 'Failed to resend rider notification');
  }
});

/**
 * Get rider assignment details for a specific order
 * GET /api/admin/orders/:id/rider-assignment
 */
export const getRiderAssignmentDetails = asyncHandler(async (req, res) => {
  try {
    const { id } = req.params;

    const order = await resolveAdminOrderById(id);
    if (!order) {
      return errorResponse(res, 404, 'Order not found');
    }

    const populated = await Order.findById(order._id)
      .populate('deliveryPartnerId', 'name phone deliveryId availability.currentLocation')
      .lean();

    const restaurantDoc = await resolveRestaurantForOrder(order);
    const isMoGrocery = isOrderAdminApprovalAllowed(restaurantDoc);

    return successResponse(res, 200, 'Rider assignment details fetched successfully', {
      orderId: populated?.orderId || order.orderId,
      status: populated?.status || order.status,
      isMoGrocery,
      adminApprovalStatus: populated?.adminApproval?.status || null,
      accepted: hasAcceptedRider(populated),
      rider: populated?.deliveryPartnerId
        ? {
            id: populated.deliveryPartnerId?._id?.toString?.() || populated.deliveryPartnerId?._id || null,
            name: populated.deliveryPartnerId?.name || null,
            phone: populated.deliveryPartnerId?.phone || null,
            deliveryId: populated.deliveryPartnerId?.deliveryId || null
          }
        : null,
      acceptedAt: populated?.deliveryState?.acceptedAt || null,
      currentPhase: populated?.deliveryState?.currentPhase || null,
      deliveryStatus: populated?.deliveryState?.status || null,
      assignmentInfo: {
        deliveryPartnerId: populated?.assignmentInfo?.deliveryPartnerId || null,
        assignedBy: populated?.assignmentInfo?.assignedBy || null,
        assignedAt: populated?.assignmentInfo?.assignedAt || null,
        notificationPhase: populated?.assignmentInfo?.notificationPhase || null,
        priorityNotifiedAt: populated?.assignmentInfo?.priorityNotifiedAt || null,
        expandedNotifiedAt: populated?.assignmentInfo?.expandedNotifiedAt || null
      }
    });
  } catch (error) {
    console.error('Error fetching rider assignment details:', error);
    return errorResponse(res, 500, 'Failed to fetch rider assignment details');
  }
});

/**
 * Get orders searching for deliveryman (ready orders without delivery partner)
 * GET /api/admin/orders/searching-deliveryman
 * Query params: page, limit, search
 */
export const getSearchingDeliverymanOrders = asyncHandler(async (req, res) => {
  try {
    console.log('🔍 Fetching searching deliveryman orders...');
    const { 
      page = 1, 
      limit = 50,
      search
    } = req.query;
    
    console.log('📋 Query params:', { page, limit, search });

    // Build base conditions for orders that are ready but don't have delivery partner assigned
    // deliveryPartnerId is ObjectId, so we only check for null or missing
    const baseConditions = {
      status: { $in: ['ready', 'preparing'] },
      $or: [
        { deliveryPartnerId: { $exists: false } },
        { deliveryPartnerId: null }
      ]
    };

    // Build search conditions if search is provided
    let searchConditions = null;
    if (search) {
      const searchOrConditions = [
        { orderId: { $regex: search, $options: 'i' } }
      ];

      // If search looks like a phone number, search in customer data
      const phoneRegex = /[\d\s\+\-()]+/;
      if (phoneRegex.test(search)) {
        const User = (await import('../../auth/models/User.js')).default;
        const cleanSearch = search.replace(/\D/g, '');
        const userSearchQuery = { phone: { $regex: cleanSearch, $options: 'i' } };
        if (mongoose.Types.ObjectId.isValid(search)) {
          userSearchQuery._id = search;
        }
        const users = await User.find(userSearchQuery).select('_id').lean();
        const userIds = users.map(u => u._id);
        if (userIds.length > 0) {
          searchOrConditions.push({ userId: { $in: userIds } });
        }
      }

      // Also search by customer name
      const User = (await import('../../auth/models/User.js')).default;
      const usersByName = await User.find({
        name: { $regex: search, $options: 'i' }
      }).select('_id').lean();
      const userIdsByName = usersByName.map(u => u._id);
      if (userIdsByName.length > 0) {
        searchOrConditions.push({ userId: { $in: userIdsByName } });
      }

      if (searchOrConditions.length > 0) {
        searchConditions = { $or: searchOrConditions };
      }
    }

    // Combine all conditions
    const adminZoneAccessCondition = buildAdminZoneAccessCondition(req.user);
    const andConditions = [baseConditions];
    if (searchConditions) andConditions.push(searchConditions);
    if (adminZoneAccessCondition) andConditions.push(adminZoneAccessCondition);
    const finalQuery = andConditions.length === 1 ? andConditions[0] : { $and: andConditions };

    // Calculate pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);

    console.log('🔎 Final query:', JSON.stringify(finalQuery, null, 2));

    // Fetch orders with population
    const orders = await Order.find(finalQuery)
      .populate('userId', 'name email phone')
      .populate('restaurantId', 'name slug')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(skip)
      .lean();

    // Get total count
    const total = await Order.countDocuments(finalQuery);
    
    console.log(`✅ Found ${orders.length} orders (total: ${total})`);

    // Transform orders to match frontend format
    const transformedOrders = orders.map((order, index) => {
      const orderDate = new Date(order.createdAt);
      const dateStr = orderDate.toLocaleDateString('en-GB', { 
        day: '2-digit', 
        month: 'short', 
        year: 'numeric' 
      }).toUpperCase();
      const timeStr = orderDate.toLocaleTimeString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: true 
      }).toUpperCase();

      // Get customer phone (masked for display)
      const customerPhone = order.userId?.phone || '';
      let maskedPhone = '';
      if (customerPhone && customerPhone.length > 2) {
        maskedPhone = `+${customerPhone.slice(0, 1)}${'*'.repeat(Math.max(0, customerPhone.length - 2))}${customerPhone.slice(-1)}`;
      } else if (customerPhone) {
        maskedPhone = customerPhone; // If too short, show as is
      }

      // Map payment status
      const paymentStatusMap = {
        'completed': 'Paid',
        'pending': 'Unpaid',
        'failed': 'Failed',
        'refunded': 'Refunded',
        'processing': 'Processing'
      };
      const paymentStatusDisplay = paymentStatusMap[order.payment?.status] || 'Unpaid';

      // Map order status for display
      const statusMap = {
        'pending': 'Pending',
        'confirmed': 'Accepted',
        'preparing': 'Pending',
        'ready': 'Pending',
        'out_for_delivery': 'Food On The Way',
        'delivered': 'Delivered',
        'cancelled': 'Canceled',
        'scheduled': 'Scheduled',
        'dine_in': 'Dine In'
      };
      const orderStatusDisplay = statusMap[order.status] || 'Pending';

      // Determine delivery type
      const deliveryType = order.deliveryFleet === 'standard' ? 
        'Home Delivery' : 
        (order.deliveryFleet === 'fast' ? 'Fast Delivery' : 'Home Delivery');

      // Format total amount
      const totalAmount = order.pricing?.total || 0;
      const formattedTotal = `$ ${totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

      return {
        id: order.orderId || order._id.toString(),
        sl: skip + index + 1,
        date: dateStr,
        time: timeStr,
        customerName: order.userId?.name || 'Unknown',
        customerPhone: maskedPhone,
        restaurant: order.restaurantName || order.restaurantId?.name || 'Unknown Restaurant',
        total: formattedTotal,
        paymentStatus: paymentStatusDisplay,
        orderStatus: orderStatusDisplay,
        deliveryType: deliveryType,
        // Additional fields for view order dialog
        orderId: order.orderId,
        _id: order._id.toString(),
        customerEmail: order.userId?.email || '',
        restaurantId: order.restaurantId?.toString() || order.restaurantId || '',
        items: order.items || [],
        address: order.address || {},
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        status: order.status,
        pricing: order.pricing || {}
      };
    });

    return successResponse(res, 200, 'Searching deliveryman orders retrieved successfully', {
      orders: transformedOrders,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('❌ Error fetching searching deliveryman orders:', error);
    console.error('Error stack:', error.stack);
    return errorResponse(res, 500, error.message || 'Failed to fetch searching deliveryman orders');
  }
});

/**
 * Get ongoing orders (orders with delivery partner assigned but not delivered)
 * GET /api/admin/orders/ongoing
 * Query params: page, limit, search
 */
export const getOngoingOrders = asyncHandler(async (req, res) => {
  try {
    console.log('🔍 Fetching ongoing orders...');
    const { 
      page = 1, 
      limit = 50,
      search
    } = req.query;
    
    console.log('📋 Query params:', { page, limit, search });

    // Build base conditions for ongoing orders
    // Orders that have deliveryPartnerId assigned but are not delivered/cancelled
    const baseConditions = {
      deliveryPartnerId: { $exists: true, $ne: null },
      status: { $nin: ['delivered', 'cancelled'] }
    };

    // Build search conditions if search is provided
    let searchConditions = null;
    if (search) {
      const searchOrConditions = [
        { orderId: { $regex: search, $options: 'i' } }
      ];

      // If search looks like a phone number, search in customer data
      const phoneRegex = /[\d\s\+\-()]+/;
      if (phoneRegex.test(search)) {
        const User = (await import('../../auth/models/User.js')).default;
        const cleanSearch = search.replace(/\D/g, '');
        const userSearchQuery = { phone: { $regex: cleanSearch, $options: 'i' } };
        if (mongoose.Types.ObjectId.isValid(search)) {
          userSearchQuery._id = search;
        }
        const users = await User.find(userSearchQuery).select('_id').lean();
        const userIds = users.map(u => u._id);
        if (userIds.length > 0) {
          searchOrConditions.push({ userId: { $in: userIds } });
        }
      }

      // Also search by customer name
      const User = (await import('../../auth/models/User.js')).default;
      const usersByName = await User.find({
        name: { $regex: search, $options: 'i' }
      }).select('_id').lean();
      const userIdsByName = usersByName.map(u => u._id);
      if (userIdsByName.length > 0) {
        searchOrConditions.push({ userId: { $in: userIdsByName } });
      }

      if (searchOrConditions.length > 0) {
        searchConditions = { $or: searchOrConditions };
      }
    }

    // Combine all conditions
    const adminZoneAccessCondition = buildAdminZoneAccessCondition(req.user);
    const andConditions = [baseConditions];
    if (searchConditions) andConditions.push(searchConditions);
    if (adminZoneAccessCondition) andConditions.push(adminZoneAccessCondition);
    const finalQuery = andConditions.length === 1 ? andConditions[0] : { $and: andConditions };

    // Calculate pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);

    console.log('🔎 Final query:', JSON.stringify(finalQuery, null, 2));

    // Fetch orders with population
    const orders = await Order.find(finalQuery)
      .populate('userId', 'name email phone')
      .populate('restaurantId', 'name slug')
      .populate('deliveryPartnerId', 'name phone')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(skip)
      .lean();

    // Get total count
    const total = await Order.countDocuments(finalQuery);
    
    console.log(`✅ Found ${orders.length} ongoing orders (total: ${total})`);

    // Transform orders to match frontend format
    const transformedOrders = orders.map((order, index) => {
      const orderDate = new Date(order.createdAt);
      const dateStr = orderDate.toLocaleDateString('en-GB', { 
        day: '2-digit', 
        month: 'short', 
        year: 'numeric' 
      }).toUpperCase();
      const timeStr = orderDate.toLocaleTimeString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: true 
      }).toUpperCase();

      // Get customer phone (masked for display)
      const customerPhone = order.userId?.phone || '';
      let maskedPhone = '';
      if (customerPhone && customerPhone.length > 2) {
        maskedPhone = `+${customerPhone.slice(0, 1)}${'*'.repeat(Math.max(0, customerPhone.length - 2))}${customerPhone.slice(-1)}`;
      } else if (customerPhone) {
        maskedPhone = customerPhone; // If too short, show as is
      }

      // Map payment status
      const paymentStatusMap = {
        'completed': 'Paid',
        'pending': 'Unpaid',
        'failed': 'Failed',
        'refunded': 'Refunded',
        'processing': 'Processing'
      };
      const paymentStatusDisplay = paymentStatusMap[order.payment?.status] || 'Unpaid';

      // Map order status for display with colors
      const statusMap = {
        'pending': { text: 'Pending', color: 'bg-gray-100 text-gray-600' },
        'confirmed': { text: 'Confirmed', color: 'bg-blue-50 text-blue-600' },
        'preparing': { text: 'Preparing', color: 'bg-yellow-50 text-yellow-600' },
        'ready': { text: 'Ready', color: 'bg-green-50 text-green-600' },
        'out_for_delivery': { text: 'Out For Delivery', color: 'bg-orange-100 text-orange-600' },
        'delivered': { text: 'Delivered', color: 'bg-green-100 text-green-600' },
        'cancelled': { text: 'Cancelled', color: 'bg-red-50 text-red-600' },
        'scheduled': { text: 'Scheduled', color: 'bg-purple-50 text-purple-600' },
        'dine_in': { text: 'Dine In', color: 'bg-indigo-50 text-indigo-600' }
      };
      
      // Check for handover status (when delivery partner has reached pickup)
      let orderStatusDisplay = statusMap[order.status]?.text || 'Pending';
      let orderStatusColor = statusMap[order.status]?.color || 'bg-gray-100 text-gray-600';
      
      // If delivery partner has reached pickup, show as "Handover"
      if (order.deliveryState?.currentPhase === 'at_pickup' || 
          order.deliveryState?.currentPhase === 'en_route_to_delivery' ||
          order.deliveryState?.currentPhase === 'at_delivery') {
        orderStatusDisplay = 'Handover';
        orderStatusColor = 'bg-blue-50 text-blue-600';
      }

      // Determine delivery type
      const deliveryType = order.deliveryFleet === 'standard' ? 
        'Home Delivery' : 
        (order.deliveryFleet === 'fast' ? 'Fast Delivery' : 'Home Delivery');

      // Format total amount
      const totalAmount = order.pricing?.total || 0;
      const formattedTotal = `$ ${totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

      return {
        id: order.orderId || order._id.toString(),
        sl: skip + index + 1,
        date: dateStr,
        time: timeStr,
        customerName: order.userId?.name || 'Unknown',
        customerPhone: maskedPhone,
        restaurant: order.restaurantName || order.restaurantId?.name || 'Unknown Restaurant',
        total: formattedTotal,
        paymentStatus: paymentStatusDisplay,
        orderStatus: orderStatusDisplay,
        orderStatusColor: orderStatusColor,
        deliveryType: deliveryType,
        // Additional fields for view order dialog
        orderId: order.orderId,
        _id: order._id.toString(),
        customerEmail: order.userId?.email || '',
        restaurantId: order.restaurantId?.toString() || order.restaurantId || '',
        items: order.items || [],
        address: order.address || {},
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        status: order.status,
        pricing: order.pricing || {},
        deliveryPartnerName: order.deliveryPartnerId?.name || null,
        deliveryPartnerPhone: order.deliveryPartnerId?.phone || null
      };
    });

    return successResponse(res, 200, 'Ongoing orders retrieved successfully', {
      orders: transformedOrders,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('❌ Error fetching ongoing orders:', error);
    console.error('Error stack:', error.stack);
    return errorResponse(res, 500, error.message || 'Failed to fetch ongoing orders');
  }
});

/**
 * Get transaction report with summary statistics and order transactions
 * GET /api/admin/orders/transaction-report
 * Query params: page, limit, search, zone, restaurant, fromDate, toDate
 */
export const getTransactionReport = asyncHandler(async (req, res) => {
  try {
    console.log('🔍 Fetching transaction report...');
    const { 
      page = 1, 
      limit = 50,
      search,
      zone,
      restaurant,
      fromDate,
      toDate,
      platform
    } = req.query;
    
    console.log('📋 Query params:', { page, limit, search, zone, restaurant, fromDate, toDate, platform });

    // Build query for orders
    const query = {};
    const addAndCondition = (condition) => {
      if (!condition) return;
      if (!query.$and) query.$and = [];
      query.$and.push(condition);
    };
    const normalizedPlatform = platform ? normalizePlatform(platform) : null;
    let platformRestaurantIds = null;
    let selectedRestaurantIds = null;
    const adminZoneAccessCondition = buildAdminZoneAccessCondition(req.user);

    addAndCondition(adminZoneAccessCondition);

    if (normalizedPlatform) {
      platformRestaurantIds = await getRestaurantIdsByPlatform(normalizedPlatform);

      const platformOrderFilter =
        normalizedPlatform === 'mogrocery'
          ? {
              $or: [
                { restaurantPlatform: 'mogrocery' },
                { platform: 'mogrocery' },
                { restaurantName: { $regex: /grocery/i } }
              ]
            }
          : {
              $and: [
                {
                  $or: [
                    { restaurantPlatform: 'mofood' },
                    { platform: 'mofood' },
                    { restaurantPlatform: { $exists: false } },
                    { platform: { $exists: false } }
                  ]
                },
                {
                  restaurantName: { $not: /grocery/i }
                }
              ]
            };

      if (platformRestaurantIds.length > 0) {
        addAndCondition({
          $or: [
            { restaurantId: { $in: platformRestaurantIds } },
            platformOrderFilter
          ]
        });
      } else {
        addAndCondition(platformOrderFilter);
      }
    }

    // Date range filter
    if (fromDate || toDate) {
      query.createdAt = {};
      if (fromDate) {
        const startDate = new Date(fromDate);
        startDate.setHours(0, 0, 0, 0);
        query.createdAt.$gte = startDate;
      }
      if (toDate) {
        const endDate = new Date(toDate);
        endDate.setHours(23, 59, 59, 999);
        query.createdAt.$lte = endDate;
      }
    }

    // Restaurant filter
    if (restaurant && restaurant !== 'All restaurants') {
      if (normalizedPlatform === 'mogrocery') {
        const GroceryStore = (await import('../../grocery/models/GroceryStore.js')).default;
        const stores = await GroceryStore.find({
          $or: [
            { name: { $regex: restaurant, $options: 'i' } },
            { storeName: { $regex: restaurant, $options: 'i' } },
            { _id: mongoose.Types.ObjectId.isValid(restaurant) ? restaurant : null },
            { restaurantId: restaurant }
          ]
        }).select('_id restaurantId').lean();

        selectedRestaurantIds = [...new Set(stores.flatMap((store) => {
          const ids = [];
          if (store?._id) ids.push(store._id.toString());
          if (store?.restaurantId) ids.push(String(store.restaurantId));
          return ids;
        }))];
      } else {
        const Restaurant = (await import('../../restaurant/models/Restaurant.js')).default;
        const restaurantDoc = await Restaurant.findOne({
          $or: [
            { name: { $regex: restaurant, $options: 'i' } },
            { _id: mongoose.Types.ObjectId.isValid(restaurant) ? restaurant : null },
            { restaurantId: restaurant }
          ]
        }).select('_id restaurantId').lean();

        if (restaurantDoc) {
          selectedRestaurantIds = [restaurantDoc._id?.toString() || restaurantDoc.restaurantId];
        }
      }

      if (selectedRestaurantIds?.length) {
        query.restaurantId = { $in: selectedRestaurantIds };
      }
    }

    // Zone filter
    if (zone && zone !== 'All Zones') {
      const Zone = (await import('../models/Zone.js')).default;
      const zoneDoc = await Zone.findOne({
        name: { $regex: zone, $options: 'i' }
      }).select('_id name').lean();

      if (zoneDoc) {
        query['assignmentInfo.zoneId'] = zoneDoc._id?.toString();
      }
    }

    // Search filter (orderId)
    if (search) {
      query.orderId = { $regex: search, $options: 'i' };
    }

    // Calculate pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Fetch only the fields needed by the report table.
    const orders = await Order.find(query)
      .select([
        '_id',
        'orderId',
        'userId',
        'restaurantName',
        'pricing.subtotal',
        'pricing.discount',
        'pricing.deliveryFee',
        'pricing.tax',
        'pricing.gst',
        'pricing.total',
        'pricing.breakdown.couponDiscountAmount',
        'pricing.breakdown.referralDiscountAmount',
        'pricing.appliedCoupon.discount',
        'pricing.referralDiscount'
      ].join(' '))
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(skip)
      .lean();

    // Get total count
    const total = await Order.countDocuments(query);

    // Resolve visible-page customer names in one batched lookup instead of populate().
    const User = (await import('../../auth/models/User.js')).default;
    const userIds = [...new Set(
      orders
        .map((order) => order?.userId)
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => id.toString())
    )];
    const users = userIds.length > 0
      ? await User.find({ _id: { $in: userIds } })
          .select('_id name')
          .lean()
      : [];
    const userMap = new Map(users.map((user) => [String(user._id), user]));

    // Calculate summary statistics
    const AdminCommission = (await import('../models/AdminCommission.js')).default;
    
    // Build date query for summary stats
    const summaryDateQuery = {};
    if (fromDate || toDate) {
      summaryDateQuery.orderDate = {};
      if (fromDate) {
        const startDate = new Date(fromDate);
        startDate.setHours(0, 0, 0, 0);
        summaryDateQuery.orderDate.$gte = startDate;
      }
      if (toDate) {
        const endDate = new Date(toDate);
        endDate.setHours(23, 59, 59, 999);
        summaryDateQuery.orderDate.$lte = endDate;
      }
    }

    // Build restaurant filter for summary
    let summaryRestaurantQuery = {};
    if (selectedRestaurantIds?.length) {
      summaryRestaurantQuery.restaurantId = { $in: selectedRestaurantIds };
    }

    // Aggregate summary amounts in MongoDB instead of loading every matching order.
    const summaryQuery = { ...query };
    const [orderSummary] = await Order.aggregate([
      { $match: summaryQuery },
      {
        $group: {
          _id: null,
          completedTransaction: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$status', 'delivered'] },
                    { $eq: ['$payment.status', 'completed'] }
                  ]
                },
                { $ifNull: ['$pricing.total', 0] },
                0
              ]
            }
          },
          refundedTransaction: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $eq: ['$payment.status', 'refunded'] },
                    { $eq: ['$status', 'cancelled'] }
                  ]
                },
                { $ifNull: ['$pricing.total', 0] },
                0
              ]
            }
          }
        }
      }
    ]);

    const completedTransaction = Number(orderSummary?.completedTransaction || 0);
    const refundedTransaction = Number(orderSummary?.refundedTransaction || 0);

    const summaryOrderIds = await Order.distinct('_id', summaryQuery);

    const settlements = summaryOrderIds.length > 0
      ? await OrderSettlement.find({ orderId: { $in: summaryOrderIds } })
          .select('adminEarning.totalEarning restaurantEarning.netEarning deliveryPartnerEarning.totalEarning')
          .lean()
      : [];

    const hasSettlementData = settlements.length > 0;

    const adminCommissionQuery = {
      status: 'completed',
      ...summaryDateQuery,
      ...summaryRestaurantQuery
    };
    const adminCommissions = !hasSettlementData
      ? await AdminCommission.find(adminCommissionQuery).lean()
      : [];

    const adminEarning = hasSettlementData
      ? settlements.reduce((sum, settlement) => sum + Number(settlement?.adminEarning?.totalEarning || 0), 0)
      : adminCommissions.reduce((sum, comm) => sum + Number(comm?.commissionAmount || 0), 0);

    const restaurantEarning = hasSettlementData
      ? settlements.reduce((sum, settlement) => sum + Number(settlement?.restaurantEarning?.netEarning || 0), 0)
      : adminCommissions.reduce((sum, comm) => sum + Number(comm?.restaurantEarning || 0), 0);

    const deliverymanEarning = hasSettlementData
      ? settlements.reduce((sum, settlement) => sum + Number(settlement?.deliveryPartnerEarning?.totalEarning || 0), 0)
      : 0;

    // Transform orders to match frontend format
    const transformedTransactions = orders.map((order, index) => {
      const subtotal = Number(order?.pricing?.subtotal || 0);
      const totalDiscount = Number(order?.pricing?.discount || 0);
      const deliveryFee = Number(order?.pricing?.deliveryFee || 0);
      const tax = Number(order?.pricing?.tax ?? order?.pricing?.gst ?? 0);
      const breakdown = order?.pricing?.breakdown || {};
      const couponDiscount = Number(
        breakdown?.couponDiscountAmount ??
        order?.pricing?.appliedCoupon?.discount ??
        0
      );
      const referralDiscount = Number(
        breakdown?.referralDiscountAmount ??
        order?.pricing?.referralDiscount ??
        0
      );
      const itemDiscount = Math.max(0, totalDiscount - couponDiscount - referralDiscount);
      const discountedAmount = Math.max(0, subtotal - totalDiscount);
      const totalItemAmount = subtotal;
      const orderAmount = Number(order?.pricing?.total || 0);
      const vatTax = tax;
      const deliveryCharge = deliveryFee;

      return {
        id: order._id.toString(),
        orderId: order.orderId,
        restaurant: order.restaurantName || 'Unknown Restaurant',
        customerName: userMap.get(String(order.userId))?.name || 'Invalid Customer Data',
        totalItemAmount: totalItemAmount,
        itemDiscount: itemDiscount,
        couponDiscount: couponDiscount,
        referralDiscount: referralDiscount,
        discountedAmount: discountedAmount,
        vatTax: vatTax,
        deliveryCharge: deliveryCharge,
        orderAmount: orderAmount,
      };
    });

    return successResponse(res, 200, 'Transaction report retrieved successfully', {
      summary: {
        completedTransaction,
        refundedTransaction,
        adminEarning,
        restaurantEarning,
        deliverymanEarning
      },
      transactions: transformedTransactions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('❌ Error fetching transaction report:', error);
    console.error('Error stack:', error.stack);
    return errorResponse(res, 500, error.message || 'Failed to fetch transaction report');
  }
});

/**
 * Get restaurant report with statistics for each restaurant
 * GET /api/admin/orders/restaurant-report
 * Query params: zone, all (active/inactive), type (commission/subscription), time, search
 */
export const getRestaurantReport = asyncHandler(async (req, res) => {
  try {
    console.log('🔍 Fetching restaurant report...');
    const { 
      platform,
      zone,
      all,
      type,
      time,
      search
    } = req.query;
    
    console.log('📋 Query params:', { platform, zone, all, type, time, search });

    const Restaurant = (await import('../../restaurant/models/Restaurant.js')).default;
    const AdminCommission = (await import('../models/AdminCommission.js')).default;
    const FeedbackExperience = (await import('../models/FeedbackExperience.js')).default;
    const Zone = (await import('../models/Zone.js')).default;
    const assignedZoneIds = getAdminAssignedZoneIds(req.user);

    // Build restaurant query
    const restaurantQuery = {};
    const andFilters = [];
    const normalizedPlatform = String(platform || '').toLowerCase().trim();
    if (normalizedPlatform === 'mogrocery') {
      restaurantQuery.platform = 'mogrocery';
    } else if (normalizedPlatform === 'mofood') {
      andFilters.push({ $or: [{ platform: 'mofood' }, { platform: { $exists: false } }] });
    }

    // Zone filter
    if (zone && zone !== 'All Zones') {
      const zoneDoc = await Zone.findOne({
        name: { $regex: zone, $options: 'i' }
      }).select('_id name').lean();

      if (zoneDoc) {
        if (assignedZoneIds.length > 0 && !assignedZoneIds.includes(String(zoneDoc._id))) {
          return successResponse(res, 200, 'Restaurant report retrieved successfully', {
            restaurants: [],
            pagination: {
              page: 1,
              limit: 1000,
              total: 0,
              pages: 0
            }
          });
        }

        // Find restaurants in this zone by checking orders with this zoneId
        const ordersInZone = await Order.find({
          'assignmentInfo.zoneId': zoneDoc._id?.toString()
        }).distinct('restaurantId').lean();

        if (ordersInZone.length > 0) {
          andFilters.push({
            $or: [
            { _id: { $in: ordersInZone } },
            { restaurantId: { $in: ordersInZone } }
            ]
          });
        } else {
          // No restaurants found in this zone
          return successResponse(res, 200, 'Restaurant report retrieved successfully', {
            restaurants: [],
            pagination: {
              page: 1,
              limit: 1000,
              total: 0,
              pages: 0
            }
          });
        }
      }
    } else if (assignedZoneIds.length > 0) {
      const ordersInAssignedZones = await Order.find({
        'assignmentInfo.zoneId': { $in: assignedZoneIds }
      }).distinct('restaurantId').lean();

      if (ordersInAssignedZones.length > 0) {
        andFilters.push({
          $or: [
            { _id: { $in: ordersInAssignedZones } },
            { restaurantId: { $in: ordersInAssignedZones } }
          ]
        });
      } else {
        return successResponse(res, 200, 'Restaurant report retrieved successfully', {
          restaurants: [],
          pagination: {
            page: 1,
            limit: 1000,
            total: 0,
            pages: 0
          }
        });
      }
    }

    // Active/Inactive filter
    if (all && all !== 'All') {
      restaurantQuery.isActive = all === 'Active';
    }

    // Search filter
    if (search) {
      const searchQuery = [
        { name: { $regex: search, $options: 'i' } },
        { restaurantId: { $regex: search, $options: 'i' } }
      ];
      andFilters.push({ $or: searchQuery });
    }

    if (andFilters.length > 0) {
      restaurantQuery.$and = andFilters;
    }

    // Get all restaurants matching the query
    const restaurants = await Restaurant.find(restaurantQuery)
      .select('_id restaurantId name profileImage rating totalRatings isActive')
      .lean();

    console.log(`📊 Found ${restaurants.length} restaurants`);

    // Date range filter for orders
    let dateQuery = {};
    if (time && time !== 'All Time') {
      const now = new Date();
      dateQuery.createdAt = {};
      
      if (time === 'Today') {
        const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
        dateQuery.createdAt.$gte = startDate;
        dateQuery.createdAt.$lte = endDate;
      } else if (time === 'This Week') {
        const dayOfWeek = now.getDay();
        const diff = now.getDate() - dayOfWeek;
        const startDate = new Date(now.getFullYear(), now.getMonth(), diff);
        const endDate = new Date(now.getFullYear(), now.getMonth(), diff + 6, 23, 59, 59);
        dateQuery.createdAt.$gte = startDate;
        dateQuery.createdAt.$lte = endDate;
      } else if (time === 'This Month') {
        const startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        const endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
        dateQuery.createdAt.$gte = startDate;
        dateQuery.createdAt.$lte = endDate;
      } else if (time === 'This Year') {
        const startDate = new Date(now.getFullYear(), 0, 1);
        const endDate = new Date(now.getFullYear(), 11, 31, 23, 59, 59);
        dateQuery.createdAt.$gte = startDate;
        dateQuery.createdAt.$lte = endDate;
      }
    }

    // Process each restaurant
    const restaurantReports = await Promise.all(
      restaurants.map(async (restaurant) => {
        const restaurantId = restaurant._id?.toString();
        const restaurantIdField = restaurant.restaurantId;

        // Build order query for this restaurant
        const orderQuery = {
          ...dateQuery,
          $or: [
            { restaurantId: restaurantId },
            { restaurantId: restaurantIdField }
          ]
        };

        // Get orders for this restaurant
        const orders = await Order.find(orderQuery).lean();

        // Calculate statistics
        const totalOrder = orders.length;
        
        // Total order amount
        const totalOrderAmount = orders.reduce((sum, order) => 
          sum + (order.pricing?.total || 0), 0
        );

        // Total discount given
        const totalDiscountGiven = orders.reduce((sum, order) => 
          sum + (order.pricing?.discount || 0), 0
        );

        // Total VAT/TAX
        const totalVATTAX = orders.reduce((sum, order) => 
          sum + (order.pricing?.tax || 0), 0
        );

        // Get unique food items (count distinct itemIds from all orders)
        const uniqueItemIds = new Set();
        orders.forEach(order => {
          if (order.items && Array.isArray(order.items)) {
            order.items.forEach(item => {
              if (item.itemId) {
                uniqueItemIds.add(item.itemId);
              }
            });
          }
        });
        const totalFood = uniqueItemIds.size;

        // Get admin commission for this restaurant
        const restaurantObjectId = restaurant._id instanceof mongoose.Types.ObjectId 
          ? restaurant._id 
          : new mongoose.Types.ObjectId(restaurant._id);

        const commissionQuery = {
          restaurantId: restaurantObjectId,
          status: 'completed'
        };

        if (dateQuery.createdAt) {
          commissionQuery.orderDate = dateQuery.createdAt;
        }

        const commissions = await AdminCommission.find(commissionQuery).lean();
        const totalAdminCommission = commissions.reduce((sum, comm) => 
          sum + (comm.commissionAmount || 0), 0
        );

        // Get ratings from FeedbackExperience
        const ratingStats = await FeedbackExperience.aggregate([
          {
            $match: {
              restaurantId: restaurantObjectId,
              rating: { $exists: true, $ne: null, $gt: 0 }
            }
          },
          {
            $group: {
              _id: null,
              averageRating: { $avg: '$rating' },
              totalRatings: { $sum: 1 }
            }
          }
        ]);

        const averageRatings = ratingStats[0]?.averageRating || restaurant.rating || 0;
        const reviews = ratingStats[0]?.totalRatings || restaurant.totalRatings || 0;

        // Format currency values
        const formatCurrency = (amount) => {
          return `₹${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        };

        return {
          sl: 0, // Will be set in frontend
          id: restaurantId,
          restaurantName: restaurant.name,
          icon: restaurant.profileImage?.url || restaurant.profileImage || null,
          totalFood,
          totalOrder,
          totalOrderAmount: formatCurrency(totalOrderAmount),
          totalDiscountGiven: formatCurrency(totalDiscountGiven),
          totalAdminCommission: formatCurrency(totalAdminCommission),
          totalVATTAX: formatCurrency(totalVATTAX),
          averageRatings: parseFloat(averageRatings.toFixed(1)),
          reviews
        };
      })
    );

    // Filter by type (Commission/Subscription) if needed
    let filteredReports = restaurantReports;
    if (type && type !== 'All types') {
      // This would require checking restaurant subscription status
      // For now, we'll return all restaurants
      // You can add subscription filtering logic here if needed
    }

    // Sort by restaurant name
    filteredReports.sort((a, b) => a.restaurantName.localeCompare(b.restaurantName));

    // Add serial numbers
    filteredReports = filteredReports.map((report, index) => ({
      ...report,
      sl: index + 1
    }));

    return successResponse(res, 200, 'Restaurant report retrieved successfully', {
      restaurants: filteredReports,
      pagination: {
        page: 1,
        limit: 1000,
        total: filteredReports.length,
        pages: 1
      }
    });
  } catch (error) {
    console.error('❌ Error fetching restaurant report:', error);
    console.error('Error stack:', error.stack);
    return errorResponse(res, 500, error.message || 'Failed to fetch restaurant report');
  }
});

/**
 * Get refund requests (restaurant cancelled orders with pending refunds)
 * GET /api/admin/refund-requests
 */
export const getRefundRequests = asyncHandler(async (req, res) => {
  try {
    console.log('✅ getRefundRequests route hit!');
    console.log('Request URL:', req.url);
    console.log('Request method:', req.method);
    console.log('Request query:', req.query);
    
    const { 
      page = 1, 
      limit = 50,
      search,
      fromDate,
      toDate,
      restaurant
    } = req.query;

    console.log('🔍 Fetching refund requests with params:', { page, limit, search, fromDate, toDate, restaurant });

    // Build query for restaurant cancelled orders with pending refunds
    const query = {
      status: 'cancelled',
      cancellationReason: { 
        $regex: /rejected by restaurant|restaurant rejected|restaurant cancelled|restaurant is too busy|item not available|outside delivery area|kitchen closing|technical issue/i 
      }
    };
    
    console.log('📋 Initial query:', JSON.stringify(query, null, 2));

    // Restaurant filter
    if (restaurant && restaurant !== 'All restaurants') {
      try {
        const Restaurant = (await import('../../restaurant/models/Restaurant.js')).default;
        const restaurantDoc = await Restaurant.findOne({
          $or: [
            { name: { $regex: restaurant, $options: 'i' } },
            ...(mongoose.Types.ObjectId.isValid(restaurant) ? [{ _id: restaurant }] : []),
            { restaurantId: restaurant }
          ]
        }).select('_id restaurantId').lean();

        if (restaurantDoc) {
          query.restaurantId = restaurantDoc._id?.toString() || restaurantDoc.restaurantId;
        }
      } catch (error) {
        console.error('Error filtering by restaurant:', error);
        // Continue without restaurant filter if there's an error
      }
    }

    // Date range filter
    if (fromDate || toDate) {
      query.cancelledAt = {};
      if (fromDate) {
        const startDate = new Date(fromDate);
        startDate.setHours(0, 0, 0, 0);
        query.cancelledAt.$gte = startDate;
      }
      if (toDate) {
        const endDate = new Date(toDate);
        endDate.setHours(23, 59, 59, 999);
        query.cancelledAt.$lte = endDate;
      }
    }

    // Search filter - build search conditions separately
    const searchConditions = [];
    if (search) {
      searchConditions.push(
        { orderId: { $regex: search, $options: 'i' } },
        { restaurantName: { $regex: search, $options: 'i' } }
      );
    }

    // Combine search with existing query
    if (searchConditions.length > 0) {
      if (Object.keys(query).length > 0 && !query.$and) {
        // Convert existing query to $and format
        const existingQuery = { ...query };
        query = {
          $and: [
            existingQuery,
            { $or: searchConditions }
          ]
        };
      } else if (query.$and) {
        // Add search to existing $and
        query.$and.push({ $or: searchConditions });
      } else {
        // Simple case - just add $or
        query.$or = searchConditions;
      }
    }

    console.log('📋 Final query:', JSON.stringify(query, null, 2));

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Fetch orders with population
    // Sort by cancelledAt if available, otherwise by createdAt
    let orders = [];
    try {
      orders = await Order.find(query)
        .populate('userId', 'name email phone')
        .populate({
          path: 'restaurantId',
          select: 'name slug',
          match: { _id: { $exists: true } } // Only populate if it's a valid ObjectId
        })
        .sort({ cancelledAt: -1, createdAt: -1 })
        .limit(parseInt(limit))
        .skip(skip)
        .lean();
      
      // Filter out orders where restaurantId population failed (null)
      orders = orders.filter(order => order.restaurantId !== null || order.restaurantName);
    } catch (error) {
      console.error('Error fetching orders:', error);
      throw error;
    }

    const total = await Order.countDocuments(query);
    console.log(`✅ Found ${total} restaurant cancelled orders`);

    // Get settlement info for each order to check refund status
    let OrderSettlement;
    try {
      OrderSettlement = (await import('../../order/models/OrderSettlement.js')).default;
    } catch (error) {
      console.error('Error importing OrderSettlement:', error);
      OrderSettlement = null;
    }
    
    const transformedOrders = await Promise.all(orders.map(async (order, index) => {
      let settlement = null;
      if (OrderSettlement) {
        try {
          settlement = await OrderSettlement.findOne({ orderId: order._id }).lean();
        } catch (error) {
          console.error(`Error fetching settlement for order ${order._id}:`, error);
        }
      }
      
      const orderDate = new Date(order.createdAt);
      const dateStr = orderDate.toLocaleDateString('en-GB', { 
        day: '2-digit', 
        month: 'short', 
        year: 'numeric' 
      }).toUpperCase();
      const timeStr = orderDate.toLocaleTimeString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: true 
      }).toUpperCase();

      const customerPhone = order.userId?.phone || '';
      
      // Check refund status from settlement
      const refundStatus = settlement?.cancellationDetails?.refundStatus || 'pending';
      const refundAmount = settlement?.cancellationDetails?.refundAmount || 0;

      return {
        sl: skip + index + 1,
        orderId: order.orderId,
        id: order._id.toString(),
        date: dateStr,
        time: timeStr,
        customerName: order.userId?.name || 'Unknown',
        customerPhone: customerPhone,
        customerEmail: order.userId?.email || '',
        restaurant: order.restaurantName || order.restaurantId?.name || 'Unknown Restaurant',
        restaurantId: order.restaurantId?.toString() || order.restaurantId || '',
        totalAmount: order.pricing?.total || 0,
        paymentStatus: order.payment?.status === 'completed' ? 'Paid' : 'Pending',
        orderStatus: 'Refund Requested',
        deliveryType: order.deliveryFleet === 'standard' ? 'Home Delivery' : 'Fast Delivery',
        cancellationReason: order.cancellationReason || 'Rejected by restaurant',
        cancelledAt: order.cancelledAt,
        refundStatus: refundStatus,
        refundAmount: refundAmount,
        settlement: settlement ? {
          cancellationStage: settlement.cancellationDetails?.cancellationStage,
          refundAmount: settlement.cancellationDetails?.refundAmount,
          restaurantCompensation: settlement.cancellationDetails?.restaurantCompensation
        } : null
      };
    }));

    console.log(`✅ Returning ${transformedOrders.length} refund requests`);
    
    return successResponse(res, 200, 'Refund requests retrieved successfully', {
      orders: transformedOrders || [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: total || 0,
        pages: Math.ceil((total || 0) / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('❌ Error fetching refund requests:', error);
    console.error('Error stack:', error.stack);
    console.error('Error details:', {
      message: error.message,
      name: error.name,
      code: error.code
    });
    return errorResponse(res, 500, error.message || 'Failed to fetch refund requests');
  }
});

/**
 * Process refund for an order via Razorpay
 * POST /api/admin/orders/:orderId/refund
 */
export const processRefund = asyncHandler(async (req, res) => {
  try {
    console.log('🔍 [processRefund] ========== ROUTE HIT ==========');
    console.log('🔍 [processRefund] Method:', req.method);
    console.log('🔍 [processRefund] URL:', req.url);
    console.log('🔍 [processRefund] Original URL:', req.originalUrl);
    console.log('🔍 [processRefund] Path:', req.path);
    console.log('🔍 [processRefund] Base URL:', req.baseUrl);
    console.log('🔍 [processRefund] Params:', req.params);
    console.log('🔍 [processRefund] Headers:', {
      authorization: req.headers.authorization ? 'Present' : 'Missing',
      'content-type': req.headers['content-type']
    });

    const { orderId } = req.params;
    const { notes, refundAmount } = req.body;
    const adminId = req.user?.id || req.admin?.id || null;

    console.log('🔍 [processRefund] Processing refund request:', {
      orderId,
      orderIdType: typeof orderId,
      orderIdLength: orderId?.length,
      isObjectId: mongoose.Types.ObjectId.isValid(orderId),
      adminId,
      url: req.url,
      method: req.method,
      params: req.params,
      body: req.body,
      refundAmount: refundAmount,
      refundAmountType: typeof refundAmount,
      notes: notes
    });

    // Find order in database - try both MongoDB _id and orderId string
    let order = null;
    
    console.log('🔍 [processRefund] Searching order in database...', {
      searchId: orderId,
      isObjectId: mongoose.Types.ObjectId.isValid(orderId) && orderId.length === 24
    });
    
    // First try MongoDB _id if it's a valid ObjectId
    if (mongoose.Types.ObjectId.isValid(orderId) && orderId.length === 24) {
      console.log('🔍 [processRefund] Searching by MongoDB _id:', orderId);
      order = await Order.findById(orderId)
        .populate('userId', 'name email phone _id')
        .lean();
      console.log('🔍 [processRefund] Order found by _id:', order ? 'Yes' : 'No');
    }
    
    // If not found by _id, try orderId string
    if (!order) {
      console.log('🔍 [processRefund] Searching by orderId string:', orderId);
      order = await Order.findOne({ orderId: orderId })
        .populate('userId', 'name email phone _id')
        .lean();
      console.log('🔍 [processRefund] Order found by orderId:', order ? 'Yes' : 'No');
    }

    if (!order) {
      console.error('❌ [processRefund] Order NOT FOUND in database');
      console.error('❌ [processRefund] Searched by:', {
        mongoId: mongoose.Types.ObjectId.isValid(orderId) && orderId.length === 24 ? orderId : 'N/A',
        orderIdString: orderId,
        orderIdType: typeof orderId,
        orderIdLength: orderId?.length
      });
      
      // Try to find any order with similar orderId (for debugging)
      try {
        const similarOrders = await Order.find({
          $or: [
            { orderId: { $regex: orderId, $options: 'i' } },
            { orderId: { $regex: orderId.substring(0, 10), $options: 'i' } }
          ]
        })
        .select('_id orderId status')
        .limit(5)
        .lean();
        
        if (similarOrders.length > 0) {
          console.log('💡 [processRefund] Found similar orders:', similarOrders.map(o => ({
            mongoId: o._id.toString(),
            orderId: o.orderId,
            status: o.status
          })));
        }
      } catch (debugError) {
        console.error('Error searching for similar orders:', debugError.message);
      }
      
      // Check total orders count
      try {
        const totalOrders = await Order.countDocuments();
        console.log(`📊 [processRefund] Total orders in database: ${totalOrders}`);
      } catch (countError) {
        console.error('Error counting orders:', countError.message);
      }
      
      return errorResponse(res, 404, `Order not found (ID: ${orderId}). Please check if the order exists.`);
    }
    
    // Verify order exists and log complete details
    console.log('✅✅✅ [processRefund] ORDER FOUND IN DATABASE ✅✅✅');
    console.log('📋 [processRefund] Complete Order Details:', {
      mongoId: order._id.toString(),
      orderId: order.orderId,
      status: order.status,
      paymentMethod: order.payment?.method || 'unknown',
      paymentType: order.paymentType || 'unknown',
      total: order.pricing?.total || 0,
      cancelledBy: order.cancelledBy || 'unknown',
      userId: order.userId?._id?.toString() || order.userId?.toString() || 'unknown',
      userName: order.userId?.name || 'unknown',
      userPhone: order.userId?.phone || 'unknown'
    });

    if (order.status !== 'cancelled') {
      return errorResponse(res, 400, 'Order is not cancelled');
    }

    // Check if it's a cancelled order (by restaurant or user)
    const isRestaurantCancelled = order.cancelledBy === 'restaurant' || 
      (order.cancellationReason && 
       /rejected by restaurant|restaurant rejected|restaurant cancelled|restaurant is too busy|item not available|outside delivery area|kitchen closing|technical issue/i.test(order.cancellationReason));
    
    const isUserCancelled = order.cancelledBy === 'user';

    if (!isRestaurantCancelled && !isUserCancelled) {
      return errorResponse(res, 400, 'This order was not cancelled by restaurant or user');
    }

    // Check payment method - wallet payments don't use Razorpay
    const paymentMethod = order.payment?.method;
    
    if (!paymentMethod) {
      return errorResponse(res, 400, 'Payment method not found for this order');
    }
    
    // For wallet payments, allow refund regardless of delivery type (no Razorpay involved)
    // For other payments (Razorpay), only allow refund for Home Delivery orders
    // Note: Order model uses deliveryFleet, not deliveryType
    if (paymentMethod !== 'wallet') {
      // Check deliveryFleet - 'standard' and 'fast' are home delivery types
      const isHomeDelivery = order.deliveryFleet === 'standard' || order.deliveryFleet === 'fast';
      if (!isHomeDelivery) {
        return errorResponse(res, 400, 'Refund can only be processed for Home Delivery orders');
      }
    }

    // Get settlement (for wallet payments, settlement might not exist - create one if needed)
    const OrderSettlement = (await import('../../order/models/OrderSettlement.js')).default;
    let settlement = await OrderSettlement.findOne({ orderId: order._id });

    // For wallet payments, if settlement doesn't exist, create a proper one with all required fields
    if (!settlement && paymentMethod === 'wallet') {
      console.log('📝 [processRefund] Settlement not found for wallet order, creating settlement with order data...');
      
      const pricing = order.pricing || {};
      const subtotal = pricing.subtotal || 0;
      const deliveryFee = pricing.deliveryFee || 0;
      const platformFee = pricing.platformFee || 0;
      const tax = pricing.tax || 0;
      const total = pricing.total || 0;
      
      // Calculate earnings (simplified for wallet refunds - we just need the structure)
      const foodPrice = subtotal;
      const commission = 0; // For wallet refunds, we don't need actual commission
      const netEarning = foodPrice; // Simplified
      
      settlement = new OrderSettlement({
        orderId: order._id,
        orderNumber: order.orderId,
        userId: order.userId?._id || order.userId,
        restaurantId: order.restaurantId,
        restaurantName: order.restaurantName || 'Unknown Restaurant',
        userPayment: {
          subtotal: subtotal,
          discount: pricing.discount || 0,
          deliveryFee: deliveryFee,
          platformFee: platformFee,
          gst: tax,
          packagingFee: 0,
          total: total
        },
        restaurantEarning: {
          foodPrice: foodPrice,
          commission: commission,
          commissionPercentage: 0,
          netEarning: netEarning,
          status: 'cancelled'
        },
        deliveryPartnerEarning: {
          basePayout: 0,
          distance: 0,
          commissionPerKm: 0,
          distanceCommission: 0,
          surgeMultiplier: 1,
          surgeAmount: 0,
          totalEarning: 0,
          status: 'cancelled'
        },
        adminEarning: {
          commission: commission,
          platformFee: platformFee,
          deliveryFee: deliveryFee,
          gst: tax,
          deliveryMargin: 0,
          totalEarning: platformFee + deliveryFee + tax,
          status: 'cancelled'
        },
        escrowStatus: 'refunded',
        escrowAmount: total,
        settlementStatus: 'cancelled',
        cancellationDetails: {
          cancelled: true,
          cancelledAt: order.updatedAt || new Date(),
          refundStatus: 'pending'
        }
      });
      await settlement.save();
      console.log('✅ [processRefund] Settlement created for wallet refund');
    } else if (!settlement) {
      // For non-wallet payments, settlement is required
      return errorResponse(res, 404, 'Settlement not found for this order');
    }

    // Check if refund already processed
    if (settlement.cancellationDetails?.refundStatus === 'processed' || 
        settlement.cancellationDetails?.refundStatus === 'initiated') {
      return errorResponse(res, 400, 'Refund already processed or initiated for this order');
    }

    // Handle wallet refunds differently (paymentMethod already declared above)
    // Wallet payments don't use Razorpay - refund is direct wallet credit
    let refundResult;
    if (paymentMethod === 'wallet') {
      // For wallet payments, use provided refundAmount or calculate from order
      const orderTotal = order.pricing?.total || settlement.userPayment?.total || 0;
      let finalRefundAmount = 0;
      
      // If refundAmount is provided in request body, use it (validate it)
      if (refundAmount !== undefined && refundAmount !== null && refundAmount !== '') {
        const requestedAmount = parseFloat(refundAmount);
        console.log('💰 [processRefund] Validating refund amount:', {
          original: refundAmount,
          parsed: requestedAmount,
          isNaN: isNaN(requestedAmount),
          orderTotal: orderTotal
        });
        
        if (isNaN(requestedAmount) || requestedAmount <= 0) {
          console.error('❌ [processRefund] Invalid refund amount:', requestedAmount);
          return errorResponse(res, 400, `Invalid refund amount provided: ${refundAmount}. Please provide a valid positive number.`);
        }
        if (requestedAmount > orderTotal) {
          console.error('❌ [processRefund] Refund amount exceeds order total:', {
            requestedAmount,
            orderTotal
          });
          return errorResponse(res, 400, `Refund amount (₹${requestedAmount}) cannot exceed order total (₹${orderTotal})`);
        }
        finalRefundAmount = requestedAmount;
        console.log('✅ [processRefund] Wallet payment - using provided refund amount:', finalRefundAmount);
      } else {
        // If no amount provided, use calculated refund or order total
        const calculatedRefund = settlement.cancellationDetails?.refundAmount || 0;
        
        // For wallet, always use order total if calculated refund is 0
        if (calculatedRefund <= 0 && orderTotal > 0) {
          console.log('💰 [processRefund] Wallet payment - using full order total for refund:', orderTotal);
          finalRefundAmount = orderTotal;
        } else if (calculatedRefund > 0) {
          finalRefundAmount = calculatedRefund;
        } else {
          return errorResponse(res, 400, 'No refund amount found for this order');
        }
      }
      
      // Update settlement with refund amount
      if (!settlement.cancellationDetails) {
        settlement.cancellationDetails = {};
      }
      settlement.cancellationDetails.refundAmount = finalRefundAmount;
      await settlement.save();
      
      // Process wallet refund (add to user wallet) with the specified amount
      const { processWalletRefund } = await import('../../order/services/cancellationRefundService.js');
      refundResult = await processWalletRefund(order._id, adminId, finalRefundAmount);
    } else {
      // For Razorpay, check if refund amount is calculated
      const refundAmount = settlement.cancellationDetails?.refundAmount || 0;
      if (refundAmount <= 0) {
        return errorResponse(res, 400, 'No refund amount calculated for this order');
      }
      
      // Process Razorpay refund
      const { processRazorpayRefund } = await import('../../order/services/cancellationRefundService.js');
      refundResult = await processRazorpayRefund(order._id, adminId);
    }

    // Update settlement with admin notes if provided
    if (notes) {
      settlement.metadata = settlement.metadata || new Map();
      settlement.metadata.set('adminRefundNotes', notes);
      await settlement.save();
    }

    return successResponse(res, 200, refundResult.message || 'Refund processed successfully', {
      orderId: order.orderId,
      refundId: refundResult.refundId,
      refundAmount: refundResult.refundAmount,
      razorpayRefund: refundResult.razorpayRefund,
      message: refundResult.message
    });
  } catch (error) {
    console.error('Error processing refund:', error);
    return errorResponse(res, 500, error.message || 'Failed to process refund');
  }
});

/**
 * Mark order as delivered directly from admin
 * PATCH /api/admin/orders/:id/deliver
 */
export const deliverOrderFromAdmin = asyncHandler(async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user?._id || req.admin?._id;

    const order = await resolveAdminOrderById(id);
    if (!order) {
      return errorResponse(res, 404, 'Order not found');
    }
    if (!canAdminAccessOrder(req.user, order)) {
      return errorResponse(res, 403, 'Access denied for orders outside your assigned zones');
    }

    if (String(order.status || '').toLowerCase() === 'cancelled') {
      return errorResponse(res, 409, 'Order has been cancelled. Cannot mark as delivered.');
    }

    const isAlreadyDelivered = order.status === 'delivered' || 
                               order.deliveryState?.currentPhase === 'completed' ||
                               order.deliveryState?.status === 'delivered';
    
    if (isAlreadyDelivered) {
      return successResponse(res, 200, 'Order is already marked as delivered', {
        orderId: order.orderId,
        orderMongoId: order._id,
        orderStatus: order.status
      });
    }

    const orderMongoId = order._id;
    const orderIdForLog = order.orderId || orderMongoId?.toString();

    // Prepare update object
    const updateData = {
      status: 'delivered',
      'tracking.delivered': {
        status: true,
        timestamp: new Date()
      },
      deliveredAt: new Date(),
      'deliveryState.status': 'delivered',
      'deliveryState.currentPhase': 'completed'
    };
    
    // Update order to delivered
    const updatedOrder = await Order.findByIdAndUpdate(
      orderMongoId,
      {
        $set: updateData
      },
      { new: true, runValidators: true }
    )
      .populate('restaurantId', 'name location address phone ownerPhone')
      .populate('userId', 'name phone')
      .lean();

    if (!updatedOrder) {
      return errorResponse(res, 500, 'Failed to update order status');
    }

    console.log(`✅ Order ${orderIdForLog} marked as delivered by admin ${adminId}`);

    // Mark COD payment as collected (admin Payment Status → Collected)
    if (order.payment?.method === 'cash' || order.payment?.method === 'cod') {
      try {
        await Payment.updateOne(
          { orderId: orderMongoId },
          { $set: { status: 'completed', completedAt: new Date() } }
        );
        console.log(`✅ COD payment marked as collected for order ${orderIdForLog}`);
      } catch (paymentUpdateError) {
        console.warn('⚠️ Could not update COD payment status:', paymentUpdateError.message);
      }
    }

    // Release escrow and distribute funds (this handles all wallet credits)
    let escrowDistributed = false;
    try {
      const { releaseEscrow } = await import('../../order/services/escrowWalletService.js');
      await releaseEscrow(orderMongoId);
      escrowDistributed = true;
      console.log(`✅ Escrow released and funds distributed for order ${orderIdForLog}`);
    } catch (escrowError) {
      console.error(`❌ Error releasing escrow for order ${orderIdForLog}:`, escrowError);
    }

    // Handle delivery partner earnings if a delivery partner was assigned
    if (order.deliveryPartnerId) {
      const deliveryId = order.deliveryPartnerId;
      let deliveryDistance = 0;
      
      if (order.deliveryState?.routeToDelivery?.distance) {
        deliveryDistance = order.deliveryState.routeToDelivery.distance;
      } else if (order.assignmentInfo?.distance) {
        deliveryDistance = order.assignmentInfo.distance;
      } else if (order.restaurantId?.location?.coordinates && order.address?.location?.coordinates) {
        const [restaurantLng, restaurantLat] = order.restaurantId.location.coordinates;
        const [customerLng, customerLat] = order.address.location.coordinates;
        
        // Haversine formula
        const R = 6371;
        const dLat = (customerLat - restaurantLat) * Math.PI / 180;
        const dLng = (customerLng - restaurantLng) * Math.PI / 180;
        const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                  Math.cos(restaurantLat * Math.PI / 180) * Math.cos(customerLat * Math.PI / 180) *
                  Math.sin(dLng/2) * Math.sin(dLng/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        deliveryDistance = R * c;
      }
      
      console.log(`📏 Delivery partner ${deliveryId} was assigned. Distance: ${deliveryDistance.toFixed(2)} km`);

      let totalEarning = 0;
      try {
        const { calculateDriverEarning } = await import('../../order/services/deliveryEarningService.js');
        const earningResult = await calculateDriverEarning(deliveryDistance, order?.platform || 'mofood');
        totalEarning = Number(earningResult.totalEarning || 0);
      } catch (commissionError) {
        console.error('⚠️ Error calculating commission using rules:', commissionError.message);
        totalEarning = order.pricing?.deliveryFee || 0;
      }

      try {
        const DeliveryWallet = (await import('../../delivery/models/DeliveryWallet.js')).default;
        const Delivery = (await import('../../delivery/models/Delivery.js')).default;

        let wallet = await DeliveryWallet.findOrCreateByDeliveryId(deliveryId);
        
        const orderIdForTransaction = orderMongoId?.toString() || orderMongoId;
        const existingTransaction = wallet.transactions?.find(
          t => t.orderId && t.orderId.toString() === orderIdForTransaction && t.type === 'payment'
        );

        if (existingTransaction) {
          console.warn(`⚠️ Earning already added for order ${orderIdForLog}, skipping wallet update`);
        } else {
          wallet.addTransaction({
            amount: totalEarning,
            type: 'payment',
            status: 'Completed',
            description: `Delivery earnings for Order #${orderIdForLog} (Distance: ${deliveryDistance.toFixed(2)} km) - Marked by Admin`,
            orderId: orderMongoId,
            paymentCollected: false
          });

          await wallet.save();

          const codAmount = Number(order.pricing?.total) || 0;
          const paymentMethod = (order.payment?.method || '').toString().toLowerCase();
          const isCashOrder = paymentMethod === 'cash' || paymentMethod === 'cod';
          if (isCashOrder && codAmount > 0) {
            await DeliveryWallet.updateOne(
              { deliveryId: deliveryId },
              { $inc: { cashInHand: codAmount, codCashCollected: codAmount } }
            );
            await Delivery.updateOne(
              { _id: deliveryId },
              { $set: { 'availability.isActiveOrder': false } }
            );
          }
        }
      } catch (walletError) {
        console.error(`❌ Error updating delivery partner wallet:`, walletError);
      }
    }

    // Try tracking update socket emit
    try {
      const serverModule = await import('../../../server.js');
      const getIO = serverModule.getIO;
      const io = getIO ? getIO() : null;
      if (io) {
        const aliases = Array.from(new Set([
          updatedOrder?._id?.toString?.(),
          updatedOrder?._id,
          updatedOrder?.orderId
        ].filter(Boolean).map(String)));

        aliases.forEach((alias) => {
          io.to(`order:${alias}`).emit('order_status_update', {
            orderId: updatedOrder?.orderId || alias,
            title: 'Order Update',
            message: 'Your order has been delivered successfully. Thank you!',
            status: 'delivered',
            phase: 'completed'
          });
        });
      }
    } catch (socketError) {
      console.warn(`⚠️ Failed to emit socket tracking update: ${socketError.message}`);
    }

    // Sync active tracking in Firebase if active
    try {
      const { upsertActiveOrderTracking } = await import('../../../shared/services/firebaseRealtimeService.js');
      if (upsertActiveOrderTracking) {
        await upsertActiveOrderTracking(String(updatedOrder.orderId || order.orderId), {
          status: 'delivered',
          phase: 'completed'
        });
      }
    } catch (firebaseErr) {
      console.warn(`⚠️ Firebase sync failed after deliverOrderFromAdmin for ${order.orderId}: ${firebaseErr.message}`);
    }

    return successResponse(res, 200, 'Order marked as delivered successfully', {
      orderId: updatedOrder.orderId,
      orderMongoId: updatedOrder._id,
      orderStatus: updatedOrder.status
    });
  } catch (error) {
    console.error('Error delivering order from admin:', error);
    return errorResponse(res, 500, error.message || 'Failed to mark order as delivered');
  }
});
