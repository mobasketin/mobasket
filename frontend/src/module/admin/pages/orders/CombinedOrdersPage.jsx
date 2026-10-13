import { useMemo, useState, useEffect, useRef, useCallback } from "react"
import { useLocation } from "react-router-dom"
import { BellRing, Loader2, Search, Bike, Volume2, VolumeX } from "lucide-react"
import { adminAPI } from "@/lib/api"
import { toast } from "sonner"
import alertSound from "@/assets/audio/alert.mp3"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import OrdersTopbar from "../../components/orders/OrdersTopbar"
import OrdersTable from "../../components/orders/OrdersTable"
import FilterPanel from "../../components/orders/FilterPanel"
import ViewOrderDialog from "../../components/orders/ViewOrderDialog"
import SettingsDialog from "../../components/orders/SettingsDialog"
import RefundModal from "../../components/orders/RefundModal"
import { useOrdersManagement } from "../../components/orders/useOrdersManagement"

const AUTO_REFRESH_MS = 10000
const SIDEBAR_ALERT_KEY = "adminAllOrdersAttentionUntil"
const ORDERS_ALERT_COUNT_KEY = "adminAllOrdersAttentionState"
const ORDER_SOUND_MUTED_KEY = "adminAllOrdersSoundMuted"
const PLATFORM_PAGE_SIZE = 200
// Every order has to load: the summary cards add up the loaded orders, so a
// page cap silently dropped the oldest ones from the totals as new orders came in.
const PLATFORM_SYNC_CONCURRENCY = 5
const canAdminDeleteOrders = (admin) =>
  String(admin?.role || "").trim().toLowerCase() === "super_admin"

const currencyFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2,
})

const getOrderAmount = (order) => {
  const amount = Number(
    order?.totalAmount ??
    order?.pricing?.total ??
    order?.total ??
    order?.amount ??
    0
  )

  return Number.isFinite(amount) ? amount : 0
}

const isAwaitingStoreDecision = (order) => {
  const backendStatus = String(order?.status || "").toLowerCase()

  if (!backendStatus) return false
  if (order?.timedOutByRestaurant) return false

  return ["pending", "confirmed", "scheduled"].includes(backendStatus)
}

const hasRiderAcceptedOrder = (order) => {
  const deliveryStateStatus = String(order?.deliveryState?.status || "").toLowerCase()

  return Boolean(
    order?.deliveryState?.acceptedAt ||
    ["accepted", "en_route_to_pickup", "at_pickup", "en_route_to_delivery", "at_delivery", "completed"].includes(deliveryStateStatus) ||
    String(order?.assignmentInfo?.assignedBy || "").toLowerCase() === "delivery_accept" ||
    ["out_for_delivery", "delivered"].includes(String(order?.status || "").toLowerCase())
  )
}

const getOrderTrackingId = (order) =>
  String(order?.id || order?._id || order?.orderId || "").trim()

const isOrderFromToday = (order) => {
  const orderDate = new Date(
    order?.createdAt ||
    order?.orderCreatedAt ||
    order?.orderDate ||
    order?.date ||
    order?.updatedAt ||
    0
  )

  if (Number.isNaN(orderDate.getTime())) {
    return false
  }

  const today = new Date()
  return (
    orderDate.getFullYear() === today.getFullYear() &&
    orderDate.getMonth() === today.getMonth() &&
    orderDate.getDate() === today.getDate()
  )
}

const isOrderIncludedInValueSummary = (order) => {
  const backendStatus = String(order?.status || "").toLowerCase()
  const adminApprovalStatus = String(order?.adminApprovalStatus || "").toLowerCase()

  if (order?.timedOutByRestaurant) return false
  if (["cancelled", "canceled"].includes(backendStatus)) return false
  if (adminApprovalStatus === "rejected") return false

  return true
}

const dedupeOrdersByTrackingId = (orders = []) => {
  const deduped = new Map()

  for (const order of Array.isArray(orders) ? orders : []) {
    const key = getOrderTrackingId(order)
    if (!key) continue

    const existing = deduped.get(key)
    if (!existing) {
      deduped.set(key, order)
      continue
    }

    const existingUpdatedAt = new Date(existing.updatedAt || existing.createdAt || 0).getTime()
    const nextUpdatedAt = new Date(order.updatedAt || order.createdAt || 0).getTime()

    if (nextUpdatedAt >= existingUpdatedAt) {
      deduped.set(key, order)
    }
  }

  return Array.from(deduped.values())
}

const getOrdersPayload = (response) => {
  const data = response?.data?.data
  return {
    orders: Array.isArray(data?.orders) ? data.orders : [],
    pagination: data?.pagination || {},
  }
}

const getStoredAdminUser = () => {
  try {
    const raw = localStorage.getItem("admin_user")
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export default function CombinedOrdersPage() {
  const location = useLocation()
  const currentAdmin = useMemo(() => getStoredAdminUser(), [])
  const [activeTab, setActiveTab] = useState(() =>
    location.pathname.includes("/all-orders") ? "all" : "today"
  )
  const [isSoundMuted, setIsSoundMuted] = useState(() => {
    try {
      return localStorage.getItem(ORDER_SOUND_MUTED_KEY) === "true"
    } catch {
      return false
    }
  })
  const [orders, setOrders] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState("")
  const [viewOrderLoading, setViewOrderLoading] = useState(false)
  const [viewOrderActionLoading, setViewOrderActionLoading] = useState(false)
  const [highlightedOrderIds, setHighlightedOrderIds] = useState([])
  const [processingRefund, setProcessingRefund] = useState(null)
  const [refundModalOpen, setRefundModalOpen] = useState(false)
  const [selectedOrderForRefund, setSelectedOrderForRefund] = useState(null)
  const [isAssignRiderOpen, setIsAssignRiderOpen] = useState(false)
  const [selectedOrderForAssignment, setSelectedOrderForAssignment] = useState(null)
  const [deliveryPartners, setDeliveryPartners] = useState([])
  const [deliveryPartnersLoading, setDeliveryPartnersLoading] = useState(false)
  const [deliverySearchQuery, setDeliverySearchQuery] = useState("")
  const [assigningDeliveryPartnerId, setAssigningDeliveryPartnerId] = useState("")
  const [dismissedAssignmentOrderIds, setDismissedAssignmentOrderIds] = useState([])
  const [assignmentOrderLoading, setAssignmentOrderLoading] = useState(false)
  const knownOrderIdsRef = useRef(new Set())
  const ordersRef = useRef([])
  const isMountedRef = useRef(true)
  const audioRef = useRef(null)
  const pendingSoundRef = useRef(false)
  const isAudioUnlockedRef = useRef(false)
  const highlightedOrderIdsRef = useRef([])
  const isStoppingAudioRef = useRef(false)
  const isSoundMutedRef = useRef(isSoundMuted)
  const ensureIncomingSoundRef = useRef(() => {})

  useEffect(() => {
    setActiveTab(location.pathname.includes("/all-orders") ? "all" : "today")
  }, [location.pathname])

  const {
    searchQuery,
    setSearchQuery,
    isFilterOpen,
    setIsFilterOpen,
    isSettingsOpen,
    setIsSettingsOpen,
    isViewOrderOpen,
    setIsViewOrderOpen,
    selectedOrder,
    setSelectedOrder,
    filters,
    setFilters,
    visibleColumns,
    filteredOrders,
    activeFiltersCount,
    restaurants,
    zones,
    deliveryPartners: orderDeliveryPartners,
    deliveryStatuses,
    handleApplyFilters,
    handleResetFilters,
    handleExport,
    handlePrintOrder,
    toggleColumn,
    resetColumns,
  } = useOrdersManagement(orders, "all", "All Platform Orders")

  const displayedOrders = useMemo(() => {
    if (activeTab === "today") {
      return filteredOrders.filter(isOrderFromToday)
    }

    return filteredOrders
  }, [activeTab, filteredOrders])

  const todayOrdersSummary = useMemo(() => {
    const todayOrders = orders.filter(isOrderFromToday)
    const totalValue = todayOrders
      .filter(isOrderIncludedInValueSummary)
      .reduce(
      (sum, order) => sum + getOrderAmount(order),
      0
      )

    return {
      count: todayOrders.length,
      totalValue,
    }
  }, [orders])

  const displayedOrdersSummary = useMemo(() => {
    const totalValue = displayedOrders
      .filter(isOrderIncludedInValueSummary)
      .reduce(
      (sum, order) => sum + getOrderAmount(order),
      0
      )

    return {
      count: displayedOrders.length,
      totalValue,
    }
  }, [displayedOrders])

  const selectedOrderIsGrocery = useMemo(
    () => String(selectedOrder?.restaurantPlatform || "").toLowerCase() === "mogrocery",
    [selectedOrder]
  )

  const canDeleteOrders = useMemo(
    () => canAdminDeleteOrders(currentAdmin),
    [currentAdmin]
  )

  const selectedAssignmentHasAcceptedRider = useMemo(
    () => hasRiderAcceptedOrder(selectedOrderForAssignment),
    [selectedOrderForAssignment]
  )

  const availableDeliveryPartnersForSelectedOrder = useMemo(() => {
    const requiredZoneId = String(selectedOrderForAssignment?.zoneId || "").trim()
    const normalizedSearch = String(deliverySearchQuery || "").trim().toLowerCase()

    return (Array.isArray(deliveryPartners) ? deliveryPartners : []).filter((partner) => {
      const isOnline = Boolean(partner?.availability?.isOnline)
      if (!isOnline) return false

      const partnerZoneIds = Array.isArray(partner?.availability?.zones)
        ? partner.availability.zones
            .map((zone) => String(zone?._id || zone?.id || zone || "").trim())
            .filter(Boolean)
        : []

      if (requiredZoneId && !partnerZoneIds.includes(requiredZoneId)) {
        return false
      }

      if (!normalizedSearch) return true

      const haystack = [
        partner?.name,
        partner?.phone,
        partner?.deliveryId,
        partner?.zone,
      ]
        .map((value) => String(value || "").toLowerCase())
        .join(" ")

      return haystack.includes(normalizedSearch)
    })
  }, [deliveryPartners, deliverySearchQuery, selectedOrderForAssignment])

  const syncSidebarAlertState = (count) => {
    const safeCount = Math.max(0, Number(count) || 0)
    try {
      const payload = JSON.stringify({
        active: safeCount > 0,
        count: safeCount,
        updatedAt: Date.now(),
      })
      localStorage.setItem(ORDERS_ALERT_COUNT_KEY, payload)
      if (safeCount > 0) {
        localStorage.setItem(SIDEBAR_ALERT_KEY, "active")
      } else {
        localStorage.removeItem(SIDEBAR_ALERT_KEY)
      }
    } catch {
      // Ignore storage sync failures.
    }
  }

  const stopIncomingSound = () => {
    pendingSoundRef.current = false
    if (!audioRef.current) return
    isStoppingAudioRef.current = true
    audioRef.current.pause()
    audioRef.current.currentTime = 0
  }

  const playIncomingSound = async () => {
    if (isSoundMuted) {
      pendingSoundRef.current = false
      stopIncomingSound()
      return
    }

    if (!audioRef.current) {
      pendingSoundRef.current = true
      return
    }

    isStoppingAudioRef.current = false
    audioRef.current.loop = true
    if (audioRef.current.paused || audioRef.current.ended) {
      audioRef.current.currentTime = 0
    }
    try {
      await audioRef.current.play()
      pendingSoundRef.current = false
    } catch {
      pendingSoundRef.current = true
    }
  }

  const ensureIncomingSound = async () => {
    if (isSoundMuted) {
      stopIncomingSound()
      return
    }

    if (!highlightedOrderIdsRef.current.length) {
      stopIncomingSound()
      return
    }

    await playIncomingSound()
  }

  ensureIncomingSoundRef.current = ensureIncomingSound

  const updateAlertStateFromHighlightedIds = (ids = []) => {
    const alertCount = Array.isArray(ids) ? ids.length : 0

    if (alertCount > 0 && !isSoundMuted) {
      ensureIncomingSound()
    } else {
      stopIncomingSound()
    }
    syncSidebarAlertState(alertCount)
  }

  const fetchOrders = async ({ showLoader = true } = {}) => {
    try {
      if (showLoader && isMountedRef.current) {
        setIsLoading(true)
      }

      const shouldFullSync = showLoader || knownOrderIdsRef.current.size === 0

      const fetchPlatformOrders = async (platform) => {
        const firstResponse = await adminAPI.getOrders({
          platform,
          page: 1,
          limit: PLATFORM_PAGE_SIZE,
        })
        const firstPayload = getOrdersPayload(firstResponse)

        if (!shouldFullSync) {
          return firstPayload.orders
        }

        const totalPages = Number(firstPayload.pagination?.pages || 1)

        if (totalPages <= 1) {
          return firstPayload.orders
        }

        const allOrders = [...firstPayload.orders]
        for (let page = 2; page <= totalPages; page += PLATFORM_SYNC_CONCURRENCY) {
          const pageNumbers = Array.from(
            { length: Math.min(PLATFORM_SYNC_CONCURRENCY, totalPages - page + 1) },
            (_, index) => page + index
          )
          const responses = await Promise.all(
            pageNumbers.map((pageNumber) =>
              adminAPI.getOrders({
                platform,
                page: pageNumber,
                limit: PLATFORM_PAGE_SIZE,
              })
            )
          )
          responses.forEach((response) => allOrders.push(...getOrdersPayload(response).orders))
        }
        return allOrders
      }

      const [mofoodOrders, mogroceryOrders] = await Promise.all([
        fetchPlatformOrders("mofood"),
        fetchPlatformOrders("mogrocery"),
      ])

      const nextOrders = shouldFullSync
        ? [...mofoodOrders, ...mogroceryOrders]
        : [...mofoodOrders, ...mogroceryOrders, ...ordersRef.current]

      const combinedOrders = dedupeOrdersByTrackingId(nextOrders).sort(
        (a, b) => new Date(b.createdAt || b.updatedAt || 0).getTime() - new Date(a.createdAt || a.updatedAt || 0).getTime()
      )

      const hasBaselineOrders = knownOrderIdsRef.current.size > 0
      const incomingIds = []
      if (hasBaselineOrders) {
        for (const order of combinedOrders) {
          const normalizedId = String(order.id || order._id || order.orderId)
          if (!knownOrderIdsRef.current.has(normalizedId)) {
            incomingIds.push(normalizedId)
          }
        }
      }

      const actionableIncomingIds = incomingIds.filter((incomingId) => {
        const matchingOrder = combinedOrders.find(
          (order) => String(order.id || order._id || order.orderId) === incomingId
        )
        return isAwaitingStoreDecision(matchingOrder)
      })
      const nextHighlightedIds = (() => {
        const previousIds = new Set((highlightedOrderIdsRef.current || []).map((id) => String(id)))
        const combinedIds = new Set([...previousIds, ...actionableIncomingIds])

        return combinedOrders
          .filter((order) => {
            const normalizedId = String(order.id || order._id || order.orderId)
            return combinedIds.has(normalizedId) && isAwaitingStoreDecision(order)
          })
          .map((order) => String(order.id || order._id || order.orderId))
      })()

      if (isMountedRef.current) {
        setHighlightedOrderIds(nextHighlightedIds)
      }
      highlightedOrderIdsRef.current = nextHighlightedIds

      updateAlertStateFromHighlightedIds(nextHighlightedIds)

      if (hasBaselineOrders && actionableIncomingIds.length > 0) {
        toast.info(`${actionableIncomingIds.length} new order${actionableIncomingIds.length > 1 ? "s" : ""} received`)
      }

      knownOrderIdsRef.current = new Set(
        combinedOrders.map((order) => String(order.id || order._id || order.orderId))
      )

      if (isMountedRef.current) {
        setOrders(combinedOrders)
        setLoadError("")
      }
    } catch (error) {
      console.error("Error fetching combined orders:", error)
      const message = error?.response?.data?.message || error.message || "Failed to fetch orders"
      if (showLoader) toast.error(message)
      if (isMountedRef.current) {
        setLoadError(message)
      }
    } finally {
      if (showLoader && isMountedRef.current) {
        setIsLoading(false)
      }
    }
  }

  const mergeOrderIntoCollections = useCallback((nextOrder) => {
    if (!nextOrder) return

    const trackingId = getOrderTrackingId(nextOrder)
    if (!trackingId) return

    setOrders((prev) =>
      prev.map((order) =>
        getOrderTrackingId(order) === trackingId
          ? { ...order, ...nextOrder, restaurantPlatform: nextOrder.restaurantPlatform || order.restaurantPlatform }
          : order
      )
    )

    setSelectedOrder((prev) =>
      prev && getOrderTrackingId(prev) === trackingId
        ? { ...prev, ...nextOrder, restaurantPlatform: nextOrder.restaurantPlatform || prev.restaurantPlatform }
        : prev
    )

    setSelectedOrderForAssignment((prev) =>
      prev && getOrderTrackingId(prev) === trackingId
        ? { ...prev, ...nextOrder, restaurantPlatform: nextOrder.restaurantPlatform || prev.restaurantPlatform }
        : prev
    )
  }, [setSelectedOrder])

  const refreshAssignmentOrderDetails = useCallback(async (orderLike, { silent = false } = {}) => {
    const orderIdToUse = getOrderTrackingId(orderLike)
    if (!orderIdToUse) return null

    try {
      if (!silent) setAssignmentOrderLoading(true)
      const response = await adminAPI.getOrderById(orderIdToUse)
      const nextOrder = response?.data?.data?.order
      if (nextOrder) {
        mergeOrderIntoCollections(nextOrder)
        return nextOrder
      }
      return null
    } catch (error) {
      if (!silent) {
        console.error("Error refreshing assignment order details:", error)
      }
      return null
    } finally {
      if (!silent) setAssignmentOrderLoading(false)
    }
  }, [mergeOrderIntoCollections])

  useEffect(() => {
    isMountedRef.current = true
    fetchOrders({ showLoader: true })

    const intervalId = setInterval(() => {
      fetchOrders({ showLoader: false })
    }, AUTO_REFRESH_MS)

    return () => {
      isMountedRef.current = false
      clearInterval(intervalId)
    }
  }, [])

  useEffect(() => {
    highlightedOrderIdsRef.current = Array.isArray(highlightedOrderIds) ? highlightedOrderIds : []
  }, [highlightedOrderIds])

  useEffect(() => {
    ordersRef.current = Array.isArray(orders) ? orders : []
  }, [orders])

  useEffect(() => {
    isSoundMutedRef.current = isSoundMuted

    try {
      localStorage.setItem(ORDER_SOUND_MUTED_KEY, String(isSoundMuted))
    } catch {
      // Ignore storage persistence failures.
    }

    if (audioRef.current) {
      audioRef.current.muted = isSoundMuted
    }

    if (isSoundMuted) {
      stopIncomingSound()
      return
    }

    if (highlightedOrderIdsRef.current.length > 0) {
      ensureIncomingSoundRef.current()
    }
  }, [isSoundMuted])

  useEffect(() => {
    audioRef.current = new Audio(alertSound)
    audioRef.current.preload = "auto"
    audioRef.current.volume = 0.85

    const unlockAudio = async () => {
      if (!audioRef.current || isAudioUnlockedRef.current) return
      try {
        audioRef.current.muted = true
        await audioRef.current.play()
        audioRef.current.pause()
        audioRef.current.currentTime = 0
        audioRef.current.muted = isSoundMutedRef.current
        isAudioUnlockedRef.current = true
        window.removeEventListener("pointerdown", unlockAudio)
        window.removeEventListener("keydown", unlockAudio)

        if (pendingSoundRef.current) {
          ensureIncomingSoundRef.current()
        }
      } catch {
        // browser still waiting for a direct user gesture
      }
    }

    const handleAudioPaused = () => {
      if (isStoppingAudioRef.current) {
        isStoppingAudioRef.current = false
        return
      }
      if (highlightedOrderIdsRef.current.length > 0) {
        pendingSoundRef.current = true
      }
    }

    const handleAudioEnded = () => {
      if (highlightedOrderIdsRef.current.length > 0) {
        pendingSoundRef.current = true
      }
    }

    audioRef.current.addEventListener("pause", handleAudioPaused)
    audioRef.current.addEventListener("ended", handleAudioEnded)

    window.addEventListener("pointerdown", unlockAudio)
    window.addEventListener("keydown", unlockAudio)
    unlockAudio()

    const retryPendingSound = () => {
      if (!isSoundMutedRef.current && pendingSoundRef.current && highlightedOrderIdsRef.current.length > 0) {
        ensureIncomingSoundRef.current()
      }
    }

    window.addEventListener("focus", retryPendingSound)
    document.addEventListener("visibilitychange", retryPendingSound)
    const watchdogId = window.setInterval(() => {
      if (!isSoundMutedRef.current && highlightedOrderIdsRef.current.length > 0) {
        const audioIsPaused = !audioRef.current || audioRef.current.paused || audioRef.current.ended
        if (pendingSoundRef.current || audioIsPaused) {
          ensureIncomingSoundRef.current()
        }
      }
    }, 2500)

    return () => {
      window.removeEventListener("pointerdown", unlockAudio)
      window.removeEventListener("keydown", unlockAudio)
      window.removeEventListener("focus", retryPendingSound)
      document.removeEventListener("visibilitychange", retryPendingSound)
      window.clearInterval(watchdogId)
      if (audioRef.current) {
        audioRef.current.removeEventListener("pause", handleAudioPaused)
        audioRef.current.removeEventListener("ended", handleAudioEnded)
        stopIncomingSound()
        audioRef.current = null
      }
      pendingSoundRef.current = false
      isAudioUnlockedRef.current = false
    }
  }, [])

  useEffect(() => {
    const prefillOrderSearch = location.state?.prefillOrderSearch
    if (!prefillOrderSearch) return
    setSearchQuery(String(prefillOrderSearch))
  }, [location.state, setSearchQuery])

  useEffect(() => {
    if (!isAssignRiderOpen || !selectedOrderForAssignment) return

    refreshAssignmentOrderDetails(selectedOrderForAssignment)
    const intervalId = window.setInterval(() => {
      refreshAssignmentOrderDetails(selectedOrderForAssignment, { silent: true })
    }, 5000)

    return () => window.clearInterval(intervalId)
  }, [isAssignRiderOpen, refreshAssignmentOrderDetails, selectedOrderForAssignment])

  const handleViewOrder = async (order) => {
    setSelectedOrder(order)
    setIsViewOrderOpen(true)
    setViewOrderLoading(true)

    try {
      const orderIdToUse = order.id || order._id || order.orderId
      const response = await adminAPI.getOrderById(orderIdToUse)
      const detailedOrder = response?.data?.data?.order
      if (detailedOrder) {
        setSelectedOrder({
          ...order,
          ...detailedOrder,
          restaurantPlatform: order.restaurantPlatform || detailedOrder.restaurantPlatform,
        })
      }
    } catch (error) {
      console.error("Error fetching order details:", error)
    } finally {
      setViewOrderLoading(false)
    }
  }

  const handleAdminAcceptStoreOrder = async (order, options = {}) => {
    const orderIdToUse = order.id || order._id || order.orderId
    if (!orderIdToUse) {
      toast.error("Order ID not found")
      return
    }

    try {
      const payload = {}
      if (Array.isArray(options?.rejectedItems) && options.rejectedItems.length > 0) {
        payload.rejectedItems = options.rejectedItems
      }

      const response = await adminAPI.acceptStoreOrderFromAdmin(orderIdToUse, payload)
      const nextHighlightedIds = highlightedOrderIds.filter((id) => String(id) !== String(orderIdToUse))
      setHighlightedOrderIds(nextHighlightedIds)
      highlightedOrderIdsRef.current = nextHighlightedIds
      updateAlertStateFromHighlightedIds(nextHighlightedIds)
      toast.success(
        String(order.restaurantPlatform || "").toLowerCase() === "mogrocery"
          ? `Order ${order.orderId} accepted by store`
          : `Order ${order.orderId} accepted by restaurant`
      )
      await fetchOrders({ showLoader: false })

      const assignedRider = response?.data?.data?.rider
      const acceptedAlreadyAssigned = Boolean(response?.data?.data?.accepted)
      if (options?.closeViewDialog) {
        setIsViewOrderOpen(false)
      }
      if (!assignedRider && !acceptedAlreadyAssigned) {
        await openAssignRiderDialog(order)
      }
    } catch (error) {
      console.error("Error accepting order from combined admin page:", error)
      toast.error(error?.response?.data?.message || "Failed to accept order")
    }
  }

  const handleOpenAcceptOrderDialog = async (order) => {
    await handleViewOrder(order)
  }

  const handleAcceptRemainingItems = async (order, rejectedItems) => {
    setViewOrderActionLoading(true)
    try {
      await handleAdminAcceptStoreOrder(order, {
        rejectedItems,
        closeViewDialog: true,
      })
    } finally {
      setViewOrderActionLoading(false)
    }
  }

  const openAssignRiderDialog = async (order) => {
    setSelectedOrderForAssignment(order)
    setDeliverySearchQuery("")
    setIsAssignRiderOpen(true)
    setDeliveryPartnersLoading(true)

    try {
      const response = await adminAPI.getDeliveryPartners({
        limit: 300,
        includeAvailability: true,
        isActive: true,
      })

      const partners = response?.data?.data?.deliveryPartners || []
      setDeliveryPartners(Array.isArray(partners) ? partners : [])
      await refreshAssignmentOrderDetails(order, { silent: true })
    } catch (error) {
      console.error("Error fetching delivery partners for manual assignment:", error)
      toast.error(error?.response?.data?.message || "Failed to load delivery partners")
      setDeliveryPartners([])
    } finally {
      setDeliveryPartnersLoading(false)
    }
  }

  const handleAssignRider = async (deliveryPartner) => {
    const orderIdToUse =
      selectedOrderForAssignment?.id ||
      selectedOrderForAssignment?._id ||
      selectedOrderForAssignment?.orderId

    const deliveryPartnerId = deliveryPartner?._id || deliveryPartner?.id

    if (!orderIdToUse || !deliveryPartnerId) {
      toast.error("Order or delivery partner is missing")
      return
    }

    try {
      setAssigningDeliveryPartnerId(String(deliveryPartnerId))
      const response = await adminAPI.assignOrderToDeliveryPartner(orderIdToUse, deliveryPartnerId)
      toast.success(
        response?.data?.data?.reassigned
          ? `Reassigned ${selectedOrderForAssignment?.orderId} to ${deliveryPartner.name || "delivery partner"}`
          : `Assigned ${deliveryPartner.name || "delivery partner"} to order ${selectedOrderForAssignment?.orderId}`
      )
      setDismissedAssignmentOrderIds((prev) =>
        prev.filter((id) => id !== String(orderIdToUse))
      )
      await fetchOrders({ showLoader: false })
      await refreshAssignmentOrderDetails(selectedOrderForAssignment, { silent: true })
    } catch (error) {
      console.error("Error assigning delivery partner manually:", error)
      toast.error(error?.response?.data?.message || "Failed to assign rider")
    } finally {
      setAssigningDeliveryPartnerId("")
    }
  }

  const handleAdminRejectStoreOrder = async (order) => {
    const orderIdToUse = order.id || order._id || order.orderId
    if (!orderIdToUse) {
      toast.error("Order ID not found")
      return
    }

    const reason = window.prompt(`Reject order ${order.orderId}\n\nEnter rejection reason:`)
    if (!reason || !reason.trim()) return

    try {
      await adminAPI.rejectStoreOrderFromAdmin(orderIdToUse, reason.trim())
      const nextHighlightedIds = highlightedOrderIds.filter((id) => String(id) !== String(orderIdToUse))
      setHighlightedOrderIds(nextHighlightedIds)
      highlightedOrderIdsRef.current = nextHighlightedIds
      updateAlertStateFromHighlightedIds(nextHighlightedIds)
      toast.success(
        String(order.restaurantPlatform || "").toLowerCase() === "mogrocery"
          ? `Order ${order.orderId} rejected by store`
          : `Order ${order.orderId} rejected by restaurant`
      )
      await fetchOrders({ showLoader: false })
    } catch (error) {
      console.error("Error rejecting order from combined admin page:", error)
      toast.error(error?.response?.data?.message || "Failed to reject order")
    }
  }

  const handleDeliverOrder = async (order) => {
    const orderIdToUse = order.id || order._id || order.orderId
    if (!orderIdToUse) {
      toast.error("Order ID not found")
      return
    }

    const confirmMessage = `Mark order ${order.orderId || orderIdToUse} as delivered?\n\nThis will update the database, release escrow, and credit delivery partner wallet (if assigned).`
    if (!window.confirm(confirmMessage)) return

    try {
      await adminAPI.deliverOrderFromAdmin(orderIdToUse)
      toast.success(`Order ${order.orderId || orderIdToUse} marked as delivered successfully`)
      await fetchOrders({ showLoader: false })
    } catch (error) {
      console.error("Error marking order as delivered:", error)
      toast.error(error?.response?.data?.message || "Failed to mark order as delivered")
    }
  }

  const handleDeleteOrder = async (order) => {
    const orderIdToUse = order.id || order._id || order.orderId
    if (!orderIdToUse) {
      toast.error("Order ID not found")
      return
    }

    if (!window.confirm(`Delete order ${order.orderId || orderIdToUse} permanently?`)) return

    try {
      await adminAPI.deleteOrder(orderIdToUse)
      toast.success(`Order ${order.orderId || orderIdToUse} deleted`)
      setOrders((prev) =>
        prev.filter(
          (currentOrder) => String(currentOrder.id || currentOrder._id || currentOrder.orderId) !== String(orderIdToUse)
        )
      )
      const nextHighlightedIds = highlightedOrderIds.filter((id) => String(id) !== String(orderIdToUse))
      setHighlightedOrderIds(nextHighlightedIds)
      highlightedOrderIdsRef.current = nextHighlightedIds
      knownOrderIdsRef.current.delete(String(orderIdToUse))
      updateAlertStateFromHighlightedIds(nextHighlightedIds)
    } catch (error) {
      console.error("Error deleting order:", error)
      toast.error(error?.response?.data?.message || "Failed to delete order")
    }
  }

  const handleRefund = (order) => {
    const isWalletPayment = order.paymentType === "Wallet" || order.payment?.method === "wallet"

    if (isWalletPayment) {
      setSelectedOrderForRefund(order)
      setRefundModalOpen(true)
      return
    }

    const confirmMessage = `Are you sure you want to process refund for order ${order.orderId}?`
    if (!window.confirm(confirmMessage)) return
    processRefund(order, null)
  }

  const processRefund = async (order, refundAmount = null) => {
    const orderIdToUse = order.id || order._id || order.orderId
    if (!orderIdToUse) {
      toast.error("Order ID not found")
      return
    }

    try {
      setProcessingRefund(orderIdToUse)
      const requestData = refundAmount !== null ? { refundAmount: parseFloat(refundAmount) } : {}
      const response = await adminAPI.processRefund(orderIdToUse, requestData)

      if (response.data?.success) {
        toast.success(response.data?.message || `Refund processed for order ${order.orderId}`)
        await fetchOrders({ showLoader: false })
      } else {
        toast.error(response.data?.message || "Failed to process refund")
      }
    } catch (error) {
      console.error("Error processing refund:", error)
      toast.error(error?.response?.data?.message || "Failed to process refund")
    } finally {
      setProcessingRefund(null)
      setRefundModalOpen(false)
      setSelectedOrderForRefund(null)
    }
  }

  const handleRefundConfirm = (amount) => {
    if (selectedOrderForRefund) {
      processRefund(selectedOrderForRefund, amount)
    }
  }

  const handleAssignRiderDialogOpenChange = (open) => {
    if (!open && selectedOrderForAssignment) {
      const orderIdToTrack = String(
        selectedOrderForAssignment.id ||
        selectedOrderForAssignment._id ||
        selectedOrderForAssignment.orderId ||
        ""
      )

      if (orderIdToTrack) {
        setDismissedAssignmentOrderIds((prev) =>
          prev.includes(orderIdToTrack) ? prev : [...prev, orderIdToTrack]
        )
      }
    }

    setIsAssignRiderOpen(open)

    if (!open) {
      setSelectedOrderForAssignment(null)
      setDeliverySearchQuery("")
      setAssigningDeliveryPartnerId("")
      setDeliveryPartners([])
    }
  }

  if (isLoading) {
    return (
      <div className="p-4 lg:p-6 bg-slate-50 min-h-screen w-full max-w-full overflow-x-hidden flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
          <p className="text-gray-600">Loading all platform orders...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen w-full max-w-full overflow-x-hidden">
      <OrdersTopbar
        title="All Platform Orders"
        count={displayedOrders.length}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        onFilterClick={() => setIsFilterOpen(true)}
        activeFiltersCount={activeFiltersCount}
        onExport={handleExport}
        onSettingsClick={() => setIsSettingsOpen(true)}
      />
      {loadError ? (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {loadError}
        </div>
      ) : null}
      <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <BellRing className="w-5 h-5 text-blue-700 shrink-0" />
          <div className="text-sm text-blue-900">
            This list combines MoFoods and MoGrocery orders, auto-refreshes every 10 seconds, and keeps new orders blinking until they are accepted or rejected.
          </div>
        </div>
        <button
          type="button"
          onClick={() => setIsSoundMuted((prev) => !prev)}
          className={`inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
            isSoundMuted
              ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
              : "border-blue-300 bg-blue-600 text-white hover:bg-blue-700"
          }`}
          aria-pressed={isSoundMuted}
          aria-label={isSoundMuted ? "Unmute new order alert sound" : "Mute new order alert sound"}
        >
          {isSoundMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          {isSoundMuted ? "Unmute Alert" : "Mute Alert"}
        </button>
      </div>
      <div className="mb-4 flex items-center gap-2">
        {[
          { key: "today", label: "Today" },
          { key: "all", label: "All" },
        ].map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`rounded-full px-4 py-2 text-sm font-semibold transition-all ${
              activeTab === tab.key
                ? "bg-slate-900 text-white shadow-sm"
                : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Daily Orders</p>
          <p className="mt-2 text-2xl font-bold text-slate-900">{todayOrdersSummary.count}</p>
          <p className="mt-1 text-sm text-slate-500">Total orders placed today</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Daily Order Value</p>
          <p className="mt-2 text-2xl font-bold text-slate-900">{currencyFormatter.format(todayOrdersSummary.totalValue)}</p>
          <p className="mt-1 text-sm text-slate-500">Combined value of today&apos;s orders</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Visible Order Count</p>
          <p className="mt-2 text-2xl font-bold text-slate-900">{displayedOrdersSummary.count}</p>
          <p className="mt-1 text-sm text-slate-500">Based on selected tab and filters</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Visible Total Value</p>
          <p className="mt-2 text-2xl font-bold text-slate-900">{currencyFormatter.format(displayedOrdersSummary.totalValue)}</p>
          <p className="mt-1 text-sm text-slate-500">Based on selected tab and filters</p>
        </div>
      </div>
      <FilterPanel
        isOpen={isFilterOpen}
        onClose={() => setIsFilterOpen(false)}
        filters={filters}
        setFilters={setFilters}
        onApply={handleApplyFilters}
        onReset={handleResetFilters}
        restaurants={restaurants}
        deliveryPartners={orderDeliveryPartners}
        deliveryStatuses={deliveryStatuses}
        zones={zones}
      />
      <SettingsDialog
        isOpen={isSettingsOpen}
        onOpenChange={setIsSettingsOpen}
        visibleColumns={visibleColumns}
        toggleColumn={toggleColumn}
        resetColumns={resetColumns}
      />
      <ViewOrderDialog
        key={`${selectedOrder?.id || selectedOrder?._id || selectedOrder?.orderId || "no-order"}-${isViewOrderOpen ? "open" : "closed"}`}
        isOpen={isViewOrderOpen}
        onOpenChange={setIsViewOrderOpen}
        order={selectedOrder}
        isGrocery={selectedOrderIsGrocery}
        isLoading={viewOrderLoading}
        isActionLoading={viewOrderActionLoading}
        onAcceptOrder={(order) => handleAdminAcceptStoreOrder(order, { closeViewDialog: true })}
        onRejectOrder={handleAdminRejectStoreOrder}
        onAcceptWithRejectedItems={handleAcceptRemainingItems}
      />
      <RefundModal
        isOpen={refundModalOpen}
        onOpenChange={setRefundModalOpen}
        order={selectedOrderForRefund}
        onConfirm={handleRefundConfirm}
        isProcessing={processingRefund !== null}
      />
      <Dialog
        open={isAssignRiderOpen}
        onOpenChange={handleAssignRiderDialogOpenChange}
      >
        <DialogContent
          className="max-w-2xl bg-white p-0 overflow-hidden"
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogHeader className="px-6 pt-6 pb-4 border-b border-slate-200">
            <DialogTitle className="flex items-center gap-2 text-slate-900">
              <Bike className="w-5 h-5 text-violet-600" />
              Assign Delivery Boy
            </DialogTitle>
            <DialogDescription className="text-slate-600">
              {selectedOrderForAssignment?.orderId
                ? `Choose an online delivery boy for order ${selectedOrderForAssignment.orderId}. Only riders from the same zone are shown.`
                : "Choose an online delivery boy from the same zone."}
            </DialogDescription>
          </DialogHeader>

          {selectedOrderForAssignment && (
            <div className="px-6 py-4 border-b border-slate-200 bg-violet-50/60">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 border border-slate-200">
                  Order {selectedOrderForAssignment.orderId}
                </span>
                {selectedAssignmentHasAcceptedRider ? (
                  <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
                    Accepted by {selectedOrderForAssignment.deliveryPartnerName || "rider"}
                  </span>
                ) : selectedOrderForAssignment.deliveryPartnerName ? (
                  <span className="inline-flex items-center rounded-full bg-sky-100 px-2.5 py-1 text-[11px] font-semibold text-sky-700">
                    Waiting for {selectedOrderForAssignment.deliveryPartnerName}
                  </span>
                ) : selectedOrderForAssignment.assignmentInfo?.lastRejectedByName ? (
                  <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-semibold text-amber-700">
                    Last declined by {selectedOrderForAssignment.assignmentInfo.lastRejectedByName}
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full bg-orange-100 px-2.5 py-1 text-[11px] font-semibold text-orange-700">
                    No rider assigned yet
                  </span>
                )}
                {assignmentOrderLoading && <Loader2 className="w-4 h-4 animate-spin text-violet-600" />}
              </div>
            </div>
          )}

          <div className="px-6 py-4 border-b border-slate-200 bg-slate-50">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input
                value={deliverySearchQuery}
                onChange={(event) => setDeliverySearchQuery(event.target.value)}
                placeholder="Search rider by name, phone, ID..."
                className="pl-9"
              />
            </div>
          </div>

          <div className="max-h-[60vh] overflow-y-auto px-6 py-4 space-y-3">
            {deliveryPartnersLoading ? (
              <div className="py-12 flex flex-col items-center justify-center gap-3">
                <Loader2 className="w-6 h-6 animate-spin text-violet-600" />
                <p className="text-sm text-slate-500">Loading available delivery boys...</p>
              </div>
            ) : availableDeliveryPartnersForSelectedOrder.length === 0 ? (
              <div className="py-12 text-center">
                <p className="text-sm font-medium text-slate-700">No online delivery boys found for this zone.</p>
                <p className="text-xs text-slate-500 mt-1">Try again when a rider comes online in this zone.</p>
              </div>
            ) : (
              availableDeliveryPartnersForSelectedOrder.map((partner) => {
                const partnerId = String(partner?._id || partner?.id || "")
                const isAssigning = assigningDeliveryPartnerId === partnerId
                const acceptedDeliveryPartnerId = String(selectedOrderForAssignment?.deliveryPartnerId || "")
                const isAcceptedPartner =
                  selectedAssignmentHasAcceptedRider &&
                  acceptedDeliveryPartnerId &&
                  acceptedDeliveryPartnerId === partnerId
                const isCurrentAssignedPartner =
                  String(selectedOrderForAssignment?.deliveryPartnerId || "") === partnerId &&
                  !selectedAssignmentHasAcceptedRider
                return (
                  <div
                    key={partnerId}
                    className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-slate-900 truncate">{partner?.name || "Delivery Boy"}</p>
                        <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                          Online
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 mt-1">{partner?.phone || "No phone"}</p>
                      <p className="text-xs text-slate-500">{partner?.deliveryId || "No rider ID"}</p>
                      <p className="text-xs text-slate-500">{partner?.zone || "Zone not available"}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-700">
                          Active orders: {Number(partner?.assignedOrders || 0)}
                        </span>
                        <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-700">
                          Total orders: {Number(partner?.totalOrders || 0)}
                        </span>
                      </div>
                    </div>
                    <Button
                      type="button"
                      onClick={() => handleAssignRider(partner)}
                      disabled={Boolean(assigningDeliveryPartnerId) || selectedAssignmentHasAcceptedRider || isCurrentAssignedPartner}
                      className="bg-violet-600 hover:bg-violet-700 text-white"
                    >
                      {isAssigning
                        ? <Loader2 className="w-4 h-4 animate-spin" />
                        : selectedAssignmentHasAcceptedRider
                          ? (isAcceptedPartner ? "Accepted" : "Locked")
                          : isCurrentAssignedPartner
                            ? "Assigned"
                            : selectedOrderForAssignment?.deliveryPartnerId
                              ? "Reassign"
                              : "Assign"}
                    </Button>
                  </div>
                )
              })
            )}
          </div>
        </DialogContent>
      </Dialog>
      <OrdersTable
        orders={displayedOrders}
        visibleColumns={visibleColumns}
        onViewOrder={handleViewOrder}
        onPrintOrder={handlePrintOrder}
        onRefund={handleRefund}
        onAdminStoreAccept={handleOpenAcceptOrderDialog}
        onAdminStoreReject={handleAdminRejectStoreOrder}
        onDeliverOrder={handleDeliverOrder}
        enableDirectAcceptAction
        enableRiderActions
        onAssignRider={openAssignRiderDialog}
        reassignableOrderIds={dismissedAssignmentOrderIds}
        onDeleteOrder={handleDeleteOrder}
        canDeleteOrder={canDeleteOrders}
        highlightedOrderIds={highlightedOrderIds}
      />
    </div>
  )
}
